/**
 * 表驱动测试：发送时的筛选与排序。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/jar.js';
import type { RequestContext } from '../src/types.js';

const T0 = Date.UTC(2026, 0, 1);

function seeded(setup: (jar: CookieJar) => void): CookieJar {
  const j = new CookieJar({ now: () => T0 });
  setup(j);
  return j;
}

test('domain + path filtering table', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'root=1');
    jar.setCookie('https://example.com/', 'deep=1; Path=/a/b');
    jar.setCookie('https://www.example.com/', 'wide=1; Domain=example.com');
    jar.setCookie('https://www.example.com/', 'host=1'); // host-only www
  });

  const cases: Array<[string, string[]]> = [
    ['https://example.com/', ['root=1', 'wide=1']],
    // host-only 的 root 只属于 example.com；www 上只有域 cookie + www 自身
    ['https://www.example.com/', ['wide=1', 'host=1']],
    ['https://www.example.com/a/b/c', ['wide=1', 'host=1']],
    // 域 example.com 上的 /a/b 路径 cookie：仅在 example.com 主机可见
    ['https://example.com/a/b/c', ['deep=1', 'root=1', 'wide=1']],
    ['https://www.example.com/a/x', ['wide=1', 'host=1']], // /a/b 不匹配
    // 子域再深一层
    ['https://sub.www.example.com/', ['wide=1']],
    // 无关域
    ['https://other.com/', []],
    // 标签边界
    ['https://notexample.com/', []],
  ];
  for (const [url, expected] of cases) {
    const header = j.cookieHeader(url);
    assert.deepEqual(header === '' ? [] : header.split('; '), expected, url);
  }
});

test('ordering: longer path first, then creation order', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'a=1; Path=/zzz');
    jar.setCookie('https://example.com/', 'b=2; Path=/aaa');
    jar.setCookie('https://example.com/', 'c=3; Path=/');
    jar.setCookie('https://example.com/', 'd=4; Path=/zzz'); // 同路径按创建序
  });
  assert.equal(
    j.cookieHeader('https://example.com/zzz'),
    'a=1; d=4; c=3',
  );
  // /aaa 与 /zzz 等长，但请求 /aaa 只匹配 /aaa 与 /
  assert.equal(
    j.cookieHeader('https://example.com/aaa'),
    'b=2; c=3',
  );
});

test('same-name cookies on different paths both sent, deeper first', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'x=root');
    jar.setCookie('https://example.com/', 'x=deep; Path=/a');
  });
  assert.equal(j.cookieHeader('https://example.com/a'), 'x=deep; x=root');
});

test('updated cookie keeps original creation position', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'first=1');
    jar.setCookie('https://example.com/', 'second=2; Path=/a');
    // 更新 first，但它的创建序仍早于 second
    jar.setCookie('https://example.com/', 'first=updated');
  });
  // / 与 /a 在请求 /a 下都匹配；/a 更长先出；first 仍在根路径且创建序不影响（路径优先）
  assert.equal(j.cookieHeader('https://example.com/a'), 'second=2; first=updated');
});

test('Secure cookies not sent over http', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 's=1; Secure');
    jar.setCookie('https://example.com/', 'n=1');
  });
  assert.equal(j.cookieHeader('http://example.com/'), 'n=1');
  assert.equal(j.cookieHeader('https://example.com/'), 's=1; n=1');
});

test('HttpOnly cookies hidden from non-HTTP APIs', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'h=1; HttpOnly');
    jar.setCookie('https://example.com/', 'v=1');
  });
  assert.equal(j.cookieHeader('https://example.com/', { httpApi: false }), 'v=1');
  assert.equal(j.cookieHeader('https://example.com/', { httpApi: true }), 'h=1; v=1');
});

interface SameSiteCase {
  name: string;
  attr: string;
  ctx: RequestContext;
  send: boolean;
}

const EMBED_A: RequestContext = {
  site: 'cross-site',
  topLevelSite: 'https://other.test/',
  method: 'GET',
};
const EMBED_POST: RequestContext = { ...EMBED_A, method: 'POST' };
const NAV_GET: RequestContext = {
  site: 'cross-site',
  topLevelSite: 'https://other.test/',
  method: 'GET',
  topLevelNavigation: true,
};
const NAV_POST: RequestContext = { ...NAV_GET, method: 'POST' };
const SAME_SITE: RequestContext = {
  site: 'same-site',
  topLevelSite: 'https://other-sub.example.com/',
  method: 'GET',
};

const SAMESITE_CASES: SameSiteCase[] = [
  // 缺省 -> Lax
  { name: '默认 Lax：跨站子请求不发送', attr: '', ctx: EMBED_A, send: false },
  { name: '默认 Lax：跨站顶层 GET 发送', attr: '', ctx: NAV_GET, send: true },
  { name: '默认 Lax：跨站顶层 POST 不发送', attr: '', ctx: NAV_POST, send: false },
  { name: '默认 Lax：同站发送', attr: '', ctx: SAME_SITE, send: true },
  // 显式 Lax
  { name: 'Lax：跨站子请求不发送', attr: '; SameSite=Lax', ctx: EMBED_A, send: false },
  { name: 'Lax：跨站顶层 GET 发送', attr: '; SameSite=Lax', ctx: NAV_GET, send: true },
  { name: 'Lax：跨站 POST 不发送', attr: '; SameSite=Lax', ctx: EMBED_POST, send: false },
  // Strict
  { name: 'Strict：跨站顶层 GET 也不发送', attr: '; SameSite=Strict', ctx: NAV_GET, send: false },
  { name: 'Strict：同站发送', attr: '; SameSite=Strict', ctx: SAME_SITE, send: true },
  // None
  { name: 'None：跨站子请求发送', attr: '; SameSite=None; Secure', ctx: EMBED_A, send: true },
  { name: 'None：同站发送', attr: '; SameSite=None; Secure', ctx: SAME_SITE, send: true },
];

test('SameSite table', () => {
  for (const c of SAMESITE_CASES) {
    const j = seeded((jar) => {
      jar.setCookie('https://example.com/', `c=1${c.attr}`);
    });
    assert.equal(
      j.cookieHeader('https://example.com/', c.ctx) === 'c=1',
      c.send,
      c.name,
    );
  }
});

test('SameSite defaults are derived from URLs', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'c=1');
  });
  // 不传 site：用请求 URL 与 topLevelSite 推导
  assert.equal(
    j.cookieHeader('https://example.com/', { topLevelSite: 'https://example.com/' }),
    'c=1',
  );
  assert.equal(
    j.cookieHeader('https://example.com/', { topLevelSite: 'https://other.test/' }),
    '',
  );
});

test('schemeful same-site: http vs https differ', () => {
  const j = seeded((jar) => {
    jar.setCookie('http://example.com/', 'c=1');
  });
  // 顶层是 https，请求是 http：站点键 scheme 不同 -> 跨站
  assert.equal(
    j.cookieHeader('http://example.com/', {
      topLevelSite: 'https://example.com/',
      site: 'cross-site',
    }),
    '',
  );
});

test('Partitioned cookies only sent under matching top-level site', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://api.example.com/', 'p=1; Secure; Partitioned', {
      topLevelSite: 'https://publisher.test/',
    });
    jar.setCookie('https://api.example.com/', 'u=1');
  });

  // 同分区：分区 cookie 发送；未分区 cookie 仍按自身 SameSite=Lax 判定，
  // 跨站子请求不发送。
  assert.equal(
    j.cookieHeader('https://api.example.com/', {
      site: 'cross-site',
      topLevelSite: 'https://publisher.test/',
    }),
    'p=1',
  );
  // 同分区且同站：两者都发送
  assert.equal(
    j.cookieHeader('https://api.example.com/', {
      site: 'same-site',
      topLevelSite: 'https://publisher.test/',
    }),
    'p=1; u=1',
  );
  // 不同分区：分区 cookie 不发送，未分区 cookie 仍受 SameSite=Lax 约束（跨站子请求 -> 不发送）
  assert.equal(
    j.cookieHeader('https://api.example.com/', {
      site: 'cross-site',
      topLevelSite: 'https://other-publisher.test/',
    }),
    '',
  );
  // 不同分区但顶层导航 GET：未分区 Lax 放行；分区 cookie 仍不发送
  assert.equal(
    j.cookieHeader('https://api.example.com/', {
      site: 'cross-site',
      topLevelSite: 'https://other-publisher.test/',
      topLevelNavigation: true,
      method: 'GET',
    }),
    'u=1',
  );
});

test('session and expiry behavior with injected clock', () => {
  let now = T0;
  const j = new CookieJar({ now: () => now });
  j.setCookie('https://example.com/', 'a=1; Max-Age=10');
  j.setCookie('https://example.com/', 's=1');
  assert.equal(j.cookieHeader('https://example.com/'), 'a=1; s=1');

  now = T0 + 10_001;
  assert.equal(j.cookieHeader('https://example.com/'), 's=1');
  assert.equal(j.size, 1);
});

test('diagnostics expose frozen snapshots only', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'a=1');
  });
  const list = j.entries();
  assert.equal(list.length, 1);
  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list[0]));
  assert.throws(() => {
    (list as unknown[]).push({} as never);
  });
  assert.throws(() => {
    (list[0] as { value: string }).value = 'hacked';
  });

  // 迭代器与快照同源
  const names = [...j].map((c) => c.name);
  assert.deepEqual(names, ['a']);
});

test('diagnostic snapshots do not mutate internal state', () => {
  const j = seeded((jar) => {
    jar.setCookie('https://example.com/', 'a=1');
  });
  const first = j.entries()[0];
  j.setCookie('https://example.com/', 'a=2');
  const second = j.entries()[0];
  assert.equal(first?.value, '1'); // 旧快照不受更新影响
  assert.equal(second?.value, '2');
});
