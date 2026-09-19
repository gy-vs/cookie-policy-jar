import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/index.js';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);
const jar = () => new CookieJar({ now: () => T });
const U = (s: string) => new URL(s);

test('未指定 SameSite 默认 Lax', () => {
  const j = jar();
  const r = j.setCookie({ url: U('https://example.com/') }, 'a=1');
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.sameSite, 'Lax');
});

interface SSRow {
  name: string;
  sameSite: string;
  secure?: boolean;
  req: {
    url: string;
    top?: string;
    topNav?: boolean;
    method?: string;
  };
  send: boolean;
}

const SS_CASES: SSRow[] = [
  // ---------- Strict ----------
  {
    name: 'Strict 同站发送',
    sameSite: 'Strict',
    req: { url: 'https://example.com/api', top: 'https://news.example.com/x' },
    send: true,
  },
  {
    name: 'Strict 跨站（即使顶层 GET 导航）不发送',
    sameSite: 'Strict',
    req: { url: 'https://example.com/api', top: 'https://other.com/', topNav: true },
    send: false,
  },
  // ---------- Lax ----------
  {
    name: 'Lax 同站子请求发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/api', top: 'https://example.com/', method: 'POST' },
    send: true,
  },
  {
    name: 'Lax 跨站顶层 GET 导航发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/', top: 'https://other.com/', topNav: true, method: 'GET' },
    send: true,
  },
  {
    name: 'Lax 跨站顶层 POST 导航不发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/', top: 'https://other.com/', topNav: true, method: 'POST' },
    send: false,
  },
  {
    name: 'Lax 跨站 iframe 子请求不发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/frame', top: 'https://other.com/', method: 'GET' },
    send: false,
  },
  {
    name: 'Lax 跨站非导航 GET（图片）不发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/pixel.gif', top: 'https://other.com/' },
    send: false,
  },
  // ---------- None ----------
  {
    name: 'None 跨站子请求发送（带 Secure）',
    sameSite: 'None',
    secure: true,
    req: { url: 'https://example.com/api', top: 'https://other.com/', method: 'POST' },
    send: true,
  },
  {
    name: 'None 同站也发送',
    sameSite: 'None',
    secure: true,
    req: { url: 'https://example.com/api', top: 'https://example.com/' },
    send: true,
  },
  // ---------- 无 topLevelUrl：视为同站上下文 ----------
  {
    name: 'Strict 无顶层上下文也发送',
    sameSite: 'Strict',
    req: { url: 'https://example.com/api' },
    send: true,
  },
  {
    name: 'Lax 无顶层上下文 POST 发送',
    sameSite: 'Lax',
    req: { url: 'https://example.com/api', method: 'POST' },
    send: true,
  },
  // ---------- 同站边界 ----------
  {
    name: '子域顶层同站：Strict 发送',
    sameSite: 'Strict',
    req: { url: 'https://api.example.com/x', top: 'https://www.example.com/' },
    send: true,
  },
  {
    name: 'co.uk 下不同注册域判跨站（Lax 子请求不发送）',
    sameSite: 'Lax',
    req: { url: 'https://a.co.uk/x', top: 'https://b.co.uk/' },
    send: false,
  },
  {
    name: 'co.uk 跨站顶层 GET 导航：Lax 仍发送',
    sameSite: 'Lax',
    req: { url: 'https://a.co.uk/x', top: 'https://b.co.uk/', topNav: true },
    send: true,
  },
];

test('SameSite 发送矩阵（表驱动）', async (t) => {
  for (const c of SS_CASES) {
    await t.test(c.name, () => {
      const j = jar();
      const attr = `SameSite=${c.sameSite}${c.secure ? '; Secure' : ''}`;
      const wr = j.setCookie({ url: U(c.req.url) }, `sid=1; ${attr}`);
      assert.equal(wr.status, 'stored');
      const header = j.getCookieHeader({
        url: U(c.req.url),
        ...(c.req.top ? { topLevelUrl: U(c.req.top) } : {}),
        ...(c.req.topNav ? { isTopLevelNavigation: true } : {}),
        ...(c.req.method ? { method: c.req.method } : {}),
      });
      assert.equal(header, c.send ? 'sid=1' : null);
    });
  }
});

test('SameSite=None 缺少 Secure 被拒绝', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('https://example.com/') },
    'a=1; SameSite=None',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'insecure-origin');
});

test('Secure Cookie 只在安全来源发送（localhost 例外可配）', () => {
  const j = jar();
  const w = j.setCookie(
    { url: U('https://example.com/') },
    'a=1; Secure',
  );
  assert.equal(w.status, 'stored');
  assert.equal(
    j.getCookieHeader({ url: U('https://example.com/') }),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: U('http://example.com/') }),
    null,
  );

  // localhost 默认视为安全
  const j2 = jar();
  j2.setCookie({ url: U('http://localhost:3000/') }, 'b=2; Secure');
  assert.equal(
    j2.getCookieHeader({ url: U('http://localhost:3000/') }),
    'b=2',
  );

  // 关闭 localhost 例外后：非 https 来源写入 Secure 被拒
  const j3 = new CookieJar({ now: () => T, treatLocalhostAsSecure: false });
  const r = j3.setCookie({ url: U('http://localhost/') }, 'c=3; Secure');
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'insecure-origin');
});

test('http 页面不能写入 Secure Cookie', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('http://example.com/') },
    'a=1; Secure',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'insecure-origin');
});

// ------------------------------------------------------------------
// Partitioned（CHIPS）
// ------------------------------------------------------------------

test('Partitioned 非安全来源拒绝（Secure 本身无法在非安全来源成立）', () => {
  const j = new CookieJar({ now: () => T, treatLocalhostAsSecure: false });
  const r = j.setCookie(
    { url: U('http://shop.example/'), topLevelUrl: U('http://news.test/') },
    'cart=1; Partitioned; Secure',
  );
  assert.equal(r.status, 'rejected');
  // 安全来源检查先于分区检查
  if (r.status === 'rejected') assert.equal(r.reason, 'insecure-origin');
});

test('Partitioned 无 Secure（安全来源）→ partitioned-requires-secure', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('https://shop.example/'), topLevelUrl: U('https://news.test/') },
    'cart=1; Partitioned',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'partitioned-requires-secure');
});

test('分区 Cookie 只在相同顶层站点键下发送', () => {
  const j = jar();
  // news.test 嵌入 shop.example，写入分区 cookie
  j.setCookie(
    { url: U('https://shop.example/frame'), topLevelUrl: U('https://news.test/') },
    'cart=1; Partitioned; Secure; SameSite=None',
  );

  // 同一顶层站点的再次嵌入：发送
  assert.equal(
    j.getCookieHeader({
      url: U('https://shop.example/frame'),
      topLevelUrl: U('https://www.news.test/'),
    }),
    'cart=1',
  );

  // 不同顶层站点嵌入：不发送
  assert.equal(
    j.getCookieHeader({
      url: U('https://shop.example/frame'),
      topLevelUrl: U('https://other.com/'),
    }),
    null,
  );

  // 顶层就是 shop.example 自己：分区键不同，不发送
  assert.equal(
    j.getCookieHeader({
      url: U('https://shop.example/frame'),
      topLevelUrl: U('https://shop.example/'),
    }),
    null,
  );
});

test('分区与非分区同名 cookie 互不影响', () => {
  const j = jar();
  j.setCookie(
    { url: U('https://shop.example/'), topLevelUrl: U('https://news.test/') },
    'sid=part; Path=/; Partitioned; Secure; SameSite=None',
  );
  j.setCookie(
    { url: U('https://shop.example/') },
    'sid=unpart; Path=/; Secure',
  );
  // news.test 嵌入：两者（非分区 Lax 同站？跨站 → Lax 不发送）只有分区发送
  assert.equal(
    j.getCookieHeader({
      url: U('https://shop.example/'),
      topLevelUrl: U('https://news.test/'),
    }),
    'sid=part',
  );
  // 第一方访问：非分区发送；分区 cookie 的键是 news.test，不发送
  assert.equal(
    j.getCookieHeader({
      url: U('https://shop.example/'),
      topLevelUrl: U('https://shop.example/'),
    }),
    'sid=unpart',
  );
});

// ------------------------------------------------------------------
// 删除精度
// ------------------------------------------------------------------

test('删除型 Set-Cookie 精确匹配 name+domain+path+partition', () => {
  const j = jar();
  j.setCookie({ url: U('https://example.com/') }, 'a=1; Path=/x');
  j.setCookie({ url: U('https://example.com/') }, 'a=2; Path=/y');
  j.setCookie({ url: U('https://example.com/') }, 'b=1; Path=/x');

  const r = j.setCookie(
    { url: U('https://example.com/') },
    'a=; Path=/x; Max-Age=0',
  );
  assert.equal(r.status, 'deleted');
  if (r.status !== 'deleted') return;
  assert.equal(r.removed, true);
  if (r.cookie) assert.equal(r.cookie.value, '1');

  // 另一条 a=/y 与 b=/x 保留
  assert.equal(j.size, 2);
  assert.equal(
    j.getCookieHeader({ url: U('https://example.com/y') }),
    'a=2',
  );
  assert.equal(
    j.getCookieHeader({ url: U('https://example.com/x') }),
    'b=1',
  );
});

test('Expires 过去时间删除分区记录时不影响非分区同名记录', () => {
  const j = jar();
  j.setCookie(
    { url: U('https://shop.example/'), topLevelUrl: U('https://news.test/') },
    'a=part; Partitioned; Secure; SameSite=None; Path=/',
  );
  j.setCookie({ url: U('https://shop.example/') }, 'a=plain; Path=/');

  const r = j.setCookie(
    { url: U('https://shop.example/'), topLevelUrl: U('https://news.test/') },
    'a=; Partitioned; Secure; SameSite=None; Path=/; Max-Age=0',
  );
  assert.equal(r.status, 'deleted');
  if (r.status !== 'deleted') return;
  assert.equal(r.removed, true);

  assert.equal(j.size, 1);
  assert.equal(
    j.getCookieHeader({ url: U('https://shop.example/') }),
    'a=plain',
  );
});

test('删除未命中的键返回 removed=false 且不新增记录', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('https://example.com/') },
    'ghost=; Path=/; Expires=Mon, 01 Jan 2024 00:00:00 GMT',
  );
  assert.equal(r.status, 'deleted');
  if (r.status !== 'deleted') return;
  assert.equal(r.removed, false);
  assert.equal(j.size, 0);
});

// ------------------------------------------------------------------
// 语法拒绝与属性解析
// ------------------------------------------------------------------

test('畸形 Set-Cookie 拒绝（表驱动）', async (t) => {
  const bad = [
    '',
    'noequals',
    '=value',
    'na me=1', // name 含空格
    'name=val ue', // value 含空格
    'name=val;ue', // value 含分号（截到属性后 value 仍为 val → 实际合法）
  ];
  for (const h of bad) {
    await t.test(JSON.stringify(h), () => {
      const j = jar();
      const r = j.setCookie({ url: U('https://example.com/') }, h);
      if (h === 'name=val;ue') {
        // 第一段 value=val 合法；ue 是无值属性
        assert.equal(r.status, 'stored');
      } else {
        assert.equal(r.status, 'rejected');
        if (r.status === 'rejected') assert.equal(r.reason, 'malformed-cookie');
      }
    });
  }
});

test('属性大小写不敏感、无值布尔属性', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('https://example.com/') },
    'a=1; SECURE; HTTPS-ONLY-NO; HTTPONLY',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.secure, true);
  assert.equal(r.cookie.httpOnly, true);
});

test('Domain=other.com 回退 host-only（不拒绝）', () => {
  const j = jar();
  const r = j.setCookie(
    { url: U('https://example.com/') },
    'a=1; Domain=other.com',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.domain, 'example.com');
  assert.equal(r.cookie.hostOnly, true);
});

// ------------------------------------------------------------------
// 诊断接口
// ------------------------------------------------------------------

test('snapshot 只读、不可篡改', () => {
  const j = jar();
  j.setCookie({ url: U('https://example.com/') }, 'a=1');
  const snap = j.snapshot();
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap[0]), true);

  assert.throws(() => {
    // @ts-expect-error 运行时验证冻结
    snap[0]!.value = 'hacked';
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error 运行时验证冻结
    snap.push({} as never);
  }, TypeError);

  // 内部状态未受影响
  assert.equal(
    j.getCookieHeader({ url: U('https://example.com/') }),
    'a=1',
  );
});

test('snapshot 的 expired 标记随注入时间变化', () => {
  const j = jar();
  j.setCookie(
    { url: U('https://example.com/') },
    'a=1; Expires=Wed, 15 Jan 2026 13:00:00 GMT',
  );
  assert.equal(j.snapshot({ now: T })[0]!.expired, false);
  assert.equal(j.snapshot({ now: T + 3600_000 })[0]!.expired, true);
});

test('迭代器遍历冻结视图', () => {
  const j = jar();
  j.setCookie({ url: U('https://example.com/') }, 'a=1');
  j.setCookie({ url: U('https://example.com/') }, 'b=2');
  const names = [];
  for (const c of j) {
    assert.equal(Object.isFrozen(c), true);
    names.push(c.name);
  }
  assert.deepEqual(names, ['a', 'b']);
});

test('getCookie 精确查询与 host-only 诊断', () => {
  const j = jar();
  j.setCookie(
    { url: U('https://sub.example.com/') },
    'a=1; Domain=example.com; Path=/p',
  );
  const hit = j.getCookie('a', 'example.com', '/p');
  assert.notEqual(hit, null);
  assert.equal(hit?.hostOnly, false);
  assert.equal(j.getCookie('a', 'sub.example.com', '/p'), null);
});
