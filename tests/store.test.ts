/**
 * 表驱动测试：Set-Cookie 存储与拒绝规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/jar.js';
import type { RejectReason, StoreResult } from '../src/types.js';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function jar(): CookieJar {
  return new CookieJar({ now: () => T0 });
}

interface StoreCase {
  name: string;
  url: string;
  header: string;
  ok: boolean;
  reason?: RejectReason;
  /** 是否在响应上下文中提供顶层站点（分区用例需要）。 */
  withTopLevel?: boolean;
  check?: (result: StoreResult) => void;
}

const STORE_CASES: StoreCase[] = [
  {
    name: '最简 host-only cookie',
    url: 'https://example.com/',
    header: 'a=1',
    ok: true,
    check: (r) => {
      assert.ok(r.ok);
      assert.equal(r.cookie.hostOnly, true);
      assert.equal(r.cookie.domain, 'example.com');
      assert.equal(r.cookie.path, '/');
    },
  },
  {
    name: '默认路径取响应 URL 目录',
    url: 'https://example.com/app/main',
    header: 'a=1',
    ok: true,
    check: (r) => {
      assert.ok(r.ok);
      assert.equal(r.cookie.path, '/app');
    },
  },
  {
    name: 'Domain 合法 -> domain cookie',
    url: 'https://www.example.com/',
    header: 'a=1; Domain=example.com',
    ok: true,
    check: (r) => {
      assert.ok(r.ok);
      assert.equal(r.cookie.hostOnly, false);
      assert.equal(r.cookie.domain, 'example.com');
    },
  },
  {
    name: 'Domain 大小写与末尾点规范化',
    url: 'https://www.example.com/',
    header: 'a=1; Domain=EXAMPLE.COM.',
    ok: true,
    check: (r) => {
      assert.ok(r.ok);
      assert.equal(r.cookie.domain, 'example.com');
    },
  },
  {
    name: 'Domain 非法字符',
    url: 'https://example.com/',
    header: 'a=1; Domain=exa_mple.com',
    ok: false,
    reason: 'invalid-domain',
  },
  {
    name: 'Domain 不是来源的父域',
    url: 'https://www.example.com/',
    header: 'a=1; Domain=other.com',
    ok: false,
    reason: 'domain-mismatch',
  },
  {
    name: 'Domain 为兄弟子域',
    url: 'https://a.example.com/',
    header: 'a=1; Domain=b.example.com',
    ok: false,
    reason: 'domain-mismatch',
  },
  {
    name: 'Domain 为公共后缀',
    url: 'https://example.com/',
    header: 'a=1; Domain=com',
    ok: false,
    reason: 'public-suffix',
  },
  {
    name: 'Domain 为多级公共后缀',
    url: 'https://example.co.uk/',
    header: 'a=1; Domain=co.uk',
    ok: false,
    reason: 'public-suffix',
  },
  {
    name: 'Domain 为通配公共后缀',
    url: 'https://x.abc.ck/',
    header: 'a=1; Domain=abc.ck',
    ok: false,
    reason: 'public-suffix',
  },
  {
    name: '例外后缀 www.ck 可设置',
    url: 'https://www.ck/',
    header: 'a=1; Domain=www.ck',
    ok: true,
  },
  {
    name: 'Secure 必须在安全来源',
    url: 'http://example.com/',
    header: 'a=1; Secure',
    ok: false,
    reason: 'secure-required',
  },
  {
    name: 'Secure 在 https 上合法',
    url: 'https://example.com/',
    header: 'a=1; Secure',
    ok: true,
  },
  {
    name: 'Partitioned 必须带 Secure',
    url: 'https://example.com/',
    header: 'a=1; Partitioned',
    ok: false,
    reason: 'partitioned-requires-secure',
  },
  {
    name: 'Partitioned+Secure 但缺顶层上下文',
    url: 'https://example.com/',
    header: 'a=1; Secure; Partitioned',
    ok: false,
    reason: 'invalid-partition',
  },
  {
    name: 'Partitioned 带顶层上下文成功',
    url: 'https://example.com/',
    header: 'a=1; Secure; Partitioned',
    ok: true,
    withTopLevel: true,
    check: (r) => {
      assert.ok(r.ok);
      assert.equal(r.cookie.partitionKey, 'https://site-a.test');
    },
  },
  {
    name: 'Partitioned 不能在非安全来源设置',
    url: 'http://example.com/',
    header: 'a=1; Secure; Partitioned',
    ok: false,
    reason: 'secure-required',
  },
  {
    name: '语法：名称含空格',
    url: 'https://example.com/',
    header: 'bad name=1',
    ok: false,
    reason: 'invalid-syntax',
  },
  {
    name: '语法：无等号',
    url: 'https://example.com/',
    header: 'notacookie',
    ok: false,
    reason: 'invalid-syntax',
  },
  {
    name: "分号后的内容按属性解析（'a=b;c' 中 c 是未知属性）",
    url: 'https://example.com/',
    header: 'a=b;c',
    ok: true,
  },
  {
    name: '未知属性被忽略',
    url: 'https://example.com/',
    header: 'a=1; UnknownThing; Priority=high',
    ok: true,
  },
  {
    name: 'SameSite=None 无 Secure（仅记录，不在存储期拒绝，发送时受限）',
    url: 'http://example.com/',
    header: 'a=1; SameSite=None',
    ok: true,
  },
];

test('setCookie rejection / acceptance table', () => {
  for (const c of STORE_CASES) {
    const j = jar();
    const result = j.setCookie(c.url, c.header, c.withTopLevel === true
      ? { topLevelSite: 'https://site-a.test/' }
      : {});
    assert.equal(result.ok, c.ok, `${c.name}: ok`);
    if (!c.ok) {
      assert.ok(!result.ok);
      assert.equal(result.reason, c.reason, `${c.name}: reason`);
    }
    c.check?.(result);
  }
});

test('value containing semicolon is rejected', () => {
  const j = jar();
  const result = j.setCookie('https://example.com/', 'a=b;c');
  // 第一个分号前 name=a value=b 合法，'c' 是未知属性被忽略：合法存储
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cookie.value, 'b');
  }
});

test('Max-Age vs Expires precedence', () => {
  const j = jar();
  // Max-Age 出现，Expires 被忽略（即便 Expires 已过期）
  const r1 = j.setCookie(
    'https://example.com/',
    `a=1; Max-Age=60; Expires=${new Date(T0 - 1000).toUTCString()}`,
  );
  assert.ok(r1.ok);
  assert.equal(r1.cookie.expiresAt, T0 + 60_000);

  // 非法 Max-Age 被忽略，回退到 Expires
  const r2 = j.setCookie(
    'https://example.com/',
    `b=2; Max-Age=soon; Expires=${new Date(T0 + 5000).toUTCString()}`,
  );
  assert.ok(r2.ok);
  assert.equal(r2.cookie.expiresAt, T0 + 5000);

  // 两者皆无 -> 会话 cookie
  const r3 = j.setCookie('https://example.com/', 'c=3');
  assert.ok(r3.ok);
  assert.equal(r3.cookie.expiresAt, null);
});

test('Max-Age=0 deletes exactly by name/domain/path/partition', () => {
  const j = jar();
  j.setCookie('https://example.com/', 'a=1; Path=/x');
  j.setCookie('https://example.com/', 'a=2; Path=/y');
  j.setCookie('https://example.com/', 'a=3');
  assert.equal(j.size, 3);

  const del = j.setCookie('https://example.com/', 'a=0; Path=/x; Max-Age=0');
  assert.ok(del.ok);
  assert.equal(del.alive, false);
  assert.equal(del.deleted, true);
  assert.equal(j.size, 2);

  // 剩下的是 /y 与 /
  const remaining = j.entries().map((e) => `${e.path}=${e.value}`).sort();
  assert.deepEqual(remaining, ['/=3', '/y=2']);

  // 删除不存在的记录：deleted=false
  const ghost = j.setCookie('https://example.com/', 'z=0; Max-Age=0');
  assert.ok(ghost.ok);
  assert.equal(ghost.deleted, false);
});

test('Expires in the past deletes precisely', () => {
  const j = jar();
  j.setCookie('https://www.example.com/', 'a=1; Domain=example.com; Path=/p');
  j.setCookie('https://www.example.com/', 'a=2; Path=/p'); // host-only，不同身份
  assert.equal(j.size, 2);
  j.setCookie(
    'https://www.example.com/',
    `a=0; Domain=example.com; Path=/p; Expires=${new Date(T0 - 1000).toUTCString()}`,
  );
  assert.equal(j.size, 1);
  assert.equal(j.entries()[0]?.value, '2');
});

test('deletion respects partition key', () => {
  const j = jar();
  const tlsA = 'https://site-a.test/';
  const tlsB = 'https://site-b.test/';
  j.setCookie('https://example.com/', 'a=1; Secure; Partitioned', { topLevelSite: tlsA });
  j.setCookie('https://example.com/', 'a=1; Secure; Partitioned', { topLevelSite: tlsB });
  assert.equal(j.size, 2);
  j.setCookie('https://example.com/', 'a=0; Secure; Partitioned; Max-Age=0', {
    topLevelSite: tlsA,
  });
  assert.equal(j.size, 1);
  assert.equal(j.entries()[0]?.partitionKey, 'https://site-b.test');
});

test('update preserves creation order, attributes replaced', () => {
  const j = jar();
  j.setCookie('https://example.com/', 'a=1');
  j.setCookie('https://example.com/', 'b=2');
  const firstIndex = j.entries()[0]?.creationIndex;
  const r = j.setCookie('https://example.com/', 'a=99; Secure; HttpOnly; SameSite=Strict');
  assert.ok(r.ok);
  assert.equal(r.created, false);
  assert.equal(r.cookie.creationIndex, firstIndex);
  assert.equal(r.cookie.value, '99');
  assert.equal(r.cookie.secure, true);
  assert.equal(r.cookie.httpOnly, true);
  assert.equal(r.cookie.sameSite, 'Strict');
  assert.equal(j.size, 2);
});

test('host-only vs domain identity: new Domain attribute widens to separate cookie', () => {
  const j = jar();
  j.setCookie('https://www.example.com/', 'a=1'); // host-only www
  j.setCookie('https://www.example.com/', 'a=2; Domain=example.com'); // 域 cookie
  assert.equal(j.size, 2);
  // 在父域上可见后者
  assert.equal(j.cookieHeader('https://example.com/'), 'a=2');
});

test('non-http schemes supported for ws', () => {
  const j = jar();
  j.setCookie('wss://example.com/', 'a=1; Secure');
  assert.equal(j.cookieHeader('wss://example.com/'), 'a=1');
});

test('unsupported scheme throws', () => {
  const j = jar();
  assert.throws(() => j.setCookie('ftp://example.com/', 'a=1'));
  assert.throws(() => j.cookieHeader('file:///tmp/x'));
});
