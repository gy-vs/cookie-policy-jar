/**
 * 边界与端到端用例：批量头、末尾点、IDN、IP 字面量、分区隔离排序、
 * 时钟推进、诊断快照稳定性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/jar.js';

const T0 = Date.UTC(2026, 0, 1);

function jar(): CookieJar {
  return new CookieJar({ now: () => T0 });
}

test('setCookies handles multiple headers independently', () => {
  const j = jar();
  const results = j.setCookies(
    'https://example.com/',
    ['a=1', 'b=2', 'bad name=3', 'c=4; Secure'],
  );
  assert.deepEqual(results.map((r) => r.ok), [true, true, false, true]);
  assert.equal(j.cookieHeader('https://example.com/'), 'a=1; b=2; c=4');
});

test('trailing-dot response host sets host-only cookie on bare host', () => {
  const j = jar();
  j.setCookie('https://example.com./', 'a=1');
  assert.equal(j.cookieHeader('https://example.com/'), 'a=1');
  assert.equal(j.cookieHeader('https://example.com./'), 'a=1');
});

test('trailing-dot Domain attribute is rejected consistently', () => {
  const j = jar();
  // 双末尾点非法；单末尾点规范化成功
  assert.equal(
    j.setCookie('https://www.example.com/', 'a=1; Domain=example.com..').ok,
    false,
  );
  assert.equal(
    j.setCookie('https://www.example.com/', 'a=1; Domain=example.com.').ok,
    true,
  );
});

test('IDN hosts normalize to punycode for storage and matching', () => {
  const j = jar();
  const r = j.setCookie('https://例え.jp/', 'a=1');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cookie.domain, 'xn--r8jz45g.jp');
  }
  assert.equal(j.cookieHeader('https://例え.jp/'), 'a=1');
  assert.equal(j.cookieHeader('https://xn--r8jz45g.jp/'), 'a=1');
});

test('IP literal hosts reject Domain attribute', () => {
  const j = jar();
  assert.equal(j.setCookie('http://1.2.3.4/', 'a=1; Domain=3.4').ok, false);
  assert.equal(j.setCookie('http://1.2.3.4/', 'a=1; Domain=2.3.4').ok, false);
  // host-only 正常
  assert.equal(j.setCookie('http://1.2.3.4/', 'a=1').ok, true);
  assert.equal(j.cookieHeader('http://1.2.3.4/'), 'a=1');
});

test('IPv6 hosts support host-only cookies', () => {
  const j = jar();
  assert.equal(j.setCookie('https://[2001:db8::1]/', 'a=1; Secure').ok, true);
  assert.equal(j.cookieHeader('https://[2001:db8::1]/'), 'a=1');
  assert.equal(j.cookieHeader('https://[2001:db8::2]/'), '');
});

test('删除型按 (name,domain,path,partition) 精确命中，不波及其他路径或主机', () => {
  const j = jar();
  j.setCookie('https://www.example.com/', 'a=domain; Domain=example.com; Path=/');
  // www 上的 host-only 记录域为 www.example.com，与 Domain=example.com 不同身份
  j.setCookie('https://www.example.com/', 'a=host; Path=/');
  // 另一条同域但路径不同
  j.setCookie('https://www.example.com/', 'a=deep; Domain=example.com; Path=/x');

  j.setCookie('https://www.example.com/', 'a=gone; Domain=example.com; Path=/; Max-Age=0');

  const alive = j
    .entries()
    .map((e) => `${e.hostOnly ? 'host' : 'domain'} ${e.domain}${e.path}=${e.value}`)
    .sort();
  assert.deepEqual(alive, [
    'domain example.com/x=deep',
    'host www.example.com/=host',
  ]);
});

test('分区与未分区记录共同参与按路径排序，并按顶层站点隔离', () => {
  const j = jar();
  j.setCookie('https://api.example.com/', 'u=1; Path=/');
  j.setCookie('https://api.example.com/', 'p=1; Secure; Partitioned; Path=/', {
    topLevelSite: 'https://publisher.test/',
  });
  // d 显式 SameSite=None，跨站子请求也发送，用于验证跨分区无关的排序
  j.setCookie('https://api.example.com/', 'd=1; Secure; SameSite=None; Path=/deep');
  // 同分区请求 /deep：d 路径更长先出，p 同分区命中；u 因 Lax 跨站子请求被挡
  const headerA = j.cookieHeader('https://api.example.com/deep', {
    site: 'cross-site',
    topLevelSite: 'https://publisher.test/',
  });
  assert.equal(headerA, 'd=1; p=1');

  // 同分区 + 同站：路径匹配的都在；d 路径最长先出，
  // 其余两条都在 "/" 上，按创建序 u 先于 p
  const headerSameSite = j.cookieHeader('https://api.example.com/deep', {
    site: 'same-site',
    topLevelSite: 'https://publisher.test/',
  });
  assert.equal(headerSameSite, 'd=1; u=1; p=1');

  // 换顶层站点：分区 p 消失；未分区的 d(SameSite=None) 仍发送
  const headerB = j.cookieHeader('https://api.example.com/deep', {
    site: 'cross-site',
    topLevelSite: 'https://other.test/',
  });
  assert.equal(headerB, 'd=1');
  // u 为默认 Lax，跨站子请求被挡
  assert.equal(
    j.cookieHeader('https://api.example.com/', {
      site: 'cross-site',
      topLevelSite: 'https://other.test/',
    }),
    '',
  );
});

test('partition key is schemeful', () => {
  const j = jar();
  j.setCookie('https://example.com/', 'a=1; Secure; Partitioned', {
    topLevelSite: 'https://site.test/',
  });
  // http 顶层站点是不同分区键
  assert.equal(
    j.cookieHeader('https://example.com/', {
      site: 'cross-site',
      topLevelSite: 'http://site.test/',
    }),
    '',
  );
});

test('expired cookies are purged as clock advances', () => {
  let now = T0;
  const j = new CookieJar({ now: () => now });
  j.setCookie('https://example.com/', 'a=1; Max-Age=5');
  j.setCookie('https://example.com/', 'b=2; Max-Age=10');
  assert.equal(j.size, 2);
  now = T0 + 5_001;
  assert.equal(j.purgeExpired(), 1);
  assert.equal(j.cookieHeader('https://example.com/'), 'b=2');
  now = T0 + 20_000;
  assert.equal(j.cookieHeader('https://example.com/'), '');
  assert.equal(j.size, 0);
});

test('Expires with Max-Age negative deletes immediately regardless of Expires', () => {
  const j = jar();
  j.setCookie('https://example.com/', 'a=1');
  const future = new Date(T0 + 999_000).toUTCString();
  const r = j.setCookie('https://example.com/', `a=2; Max-Age=-1; Expires=${future}`);
  assert.ok(r.ok);
  assert.equal(r.alive, false);
  assert.equal(j.size, 0);
});

test('malformed Expires falls back to session cookie when no Max-Age', () => {
  const j = jar();
  const r = j.setCookie('https://example.com/', 'a=1; Expires=garbage');
  assert.ok(r.ok);
  assert.equal(r.cookie.expiresAt, null);
});

test('quotes in cookie value accepted as cookie-octet', () => {
  const j = jar();
  const r = j.setCookie('https://example.com/', 'a=""');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.cookie.value, '""');
  }
});

test('cookieHeader returns empty string when nothing matches', () => {
  const j = jar();
  assert.equal(j.cookieHeader('https://example.com/'), '');
  j.setCookie('https://example.com/', 'a=1');
  assert.equal(j.cookieHeader('https://other.com/'), '');
});

test('entries snapshot survives purge and subsequent writes', () => {
  let now = T0;
  const j = new CookieJar({ now: () => now });
  j.setCookie('https://example.com/', 'a=1; Max-Age=10');
  const snapshot = j.entries();
  now = T0 + 20_000;
  j.setCookie('https://example.com/', 'b=2');
  assert.equal(j.size, 1);
  // 旧快照仍记录过期的 a，且不被内部 purge 影响
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.name, 'a');
});
