import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/index.js';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);
const jar = () => new CookieJar({ now: () => T });

test('末尾点请求主机与无点来源的 Cookie 互通', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/');
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com./') }),
    'a=1',
  );
});

test('写入来源带末尾点、请求不带点同样互通', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com./d/') }, 'a=1');
  // 默认 path=/d
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/d/x') }),
    'a=1',
  );
});

test('Domain 与主机大小写差异不影响匹配', () => {
  const j = jar();
  j.setCookie(
    { url: new URL('https://SUB.Example.COM/') },
    'a=1; Domain=example.COM; Path=/',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://sub.example.com/') }),
    'a=1',
  );
});

test('value 成对双引号被剥离；含空格仍按畸形拒绝', () => {
  const j = jar();
  const bad = j.setCookie(
    { url: new URL('https://example.com/') },
    'a="quoted value"; Path=/',
  );
  assert.equal(bad.status, 'rejected');
  if (bad.status === 'rejected') assert.equal(bad.reason, 'malformed-cookie');

  const ok = j.setCookie(
    { url: new URL('https://example.com/') },
    'b="pv123"; Path=/',
  );
  assert.equal(ok.status, 'stored');
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }),
    'b=pv123',
  );
});

test('无匹配返回 null（而非空串）', () => {
  const j = jar();
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }),
    null,
  );
});

test('Host-only 与 Domain cookie 同名同路径覆盖关系：先 host-only 后 domain 覆盖', () => {
  const j = jar();
  // RFC 6265：domain 与 host 相同且 path 相同 → 视为同一 cookie
  j.setCookie({ url: new URL('https://example.com/') }, 'a=host; Path=/');
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=dom; Domain=example.com; Path=/',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.replaced, true);
  assert.equal(r.cookie.hostOnly, false);
  assert.equal(j.size, 1);
  assert.equal(
    j.getCookieHeader({ url: new URL('https://sub.example.com/') }),
    'a=dom',
  );
});

test('更新时修改 Secure/SameSite/Expires 等属性均生效', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/');
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=2; Path=/; Secure; SameSite=Strict; Max-Age=60',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.secure, true);
  assert.equal(r.cookie.sameSite, 'Strict');
  assert.equal(r.cookie.expiresAt, T + 60_000);
  assert.equal(r.cookie.creationIndex, 0); // 创建序保留
});

test('会话 Cookie 不被时间推进淘汰', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/');
  assert.equal(
    j.getCookieHeader(
      { url: new URL('https://example.com/') },
      { now: T + 10 * 365 * 86400_000 },
    ),
    'a=1',
  );
});

test('未知属性被忽略', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Path=/; Priority=High; UnknownThing; SameSite=Bogus',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  // 无法识别的 SameSite → Lax
  assert.equal(r.cookie.sameSite, 'Lax');
});

test('HEAD/OPTIONS/TRACE 视为安全方法参与 Lax 导航语义', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/');
  for (const method of ['HEAD', 'OPTIONS', 'TRACE']) {
    assert.equal(
      j.getCookieHeader({
        url: new URL('https://example.com/'),
        topLevelUrl: new URL('https://other.com/'),
        isTopLevelNavigation: true,
        method,
      }),
      'a=1',
      method,
    );
  }
  assert.equal(
    j.getCookieHeader({
      url: new URL('https://example.com/'),
      topLevelUrl: new URL('https://other.com/'),
      isTopLevelNavigation: true,
      method: 'PUT',
    }),
    null,
  );
});
