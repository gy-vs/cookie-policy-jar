import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain,
  domainMatch,
  requestHost,
  siteInfo,
  siteKey,
  isSameSite,
  DEFAULT_SUFFIX_REGISTRY,
  CookieJar,
} from '../src/index.js';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);
const jar = () => new CookieJar({ now: () => T });

test('normalizeDomain 表驱动', async (t) => {
  const cases: [string, string | null][] = [
    ['example.com', 'example.com'],
    ['EXAMPLE.COM', 'example.com'],
    ['Example.CoM.', 'example.com'], // 单个末尾点
    ['a.b.example.com', 'a.b.example.com'],
    ['localhost', 'localhost'],
    ['  example.com  ', 'example.com'],
    // 非法
    ['', null],
    ['.example.com', null], // 前导点（应在调用前剥离，规范化层拒绝）
    ['example..com', null],
    ['example.com..', null],
    ['exa mple.com', null],
    ['exämple.com', null], // 不接受非 ASCII（需先 punycode）
    ['-bad.com', null],
    ['bad-.com', null],
    ['good.label-x.com', 'good.label-x.com'],
    ['a'.repeat(64) + '.com', null], // 标签超长
    ['a'.repeat(63) + '.com', 'a'.repeat(63) + '.com'],
    ['ex_ample.com', null],
    ['127.0.0.1', '127.0.0.1'],
  ];
  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.equal(normalizeDomain(input), expected);
    });
  }
});

test('requestHost 末尾点 / 大小写规范化', () => {
  assert.equal(requestHost(new URL('https://EXAMPLE.com./x')), 'example.com');
  assert.equal(
    requestHost(new URL('https://sub.Example.COM/x')),
    'sub.example.com',
  );
  assert.equal(requestHost(new URL('http://[::1]/x')), '[::1]');
});

test('domainMatch', async (t) => {
  const cases: [string, string, boolean][] = [
    ['example.com', 'example.com', true],
    ['sub.example.com', 'example.com', true],
    ['notexample.com', 'example.com', false], // 不得是字符串后缀
    ['example.com', 'sub.example.com', false],
    ['a.b.example.com', 'b.example.com', true],
    ['[::1]', '[::1]', true],
  ];
  for (const [host, dom, expected] of cases) {
    await t.test(`${host} vs ${dom}`, () => {
      assert.equal(domainMatch(host, dom), expected);
    });
  }
});

test('siteInfo 公共后缀表驱动', async (t) => {
  const cases: [string, string, string, boolean][] = [
    // host, publicSuffix, registrableDomain, hostIsSuffix
    ['example.com', 'com', 'example.com', false],
    ['sub.example.com', 'com', 'example.com', false],
    ['example.co.uk', 'co.uk', 'example.co.uk', false],
    ['a.b.example.co.uk', 'co.uk', 'example.co.uk', false],
    ['example.github.io', 'github.io', 'example.github.io', false],
    ['com', 'com', 'com', true],
    ['co.uk', 'co.uk', 'co.uk', true],
    ['deep.nomatch.example', 'example', 'nomatch.example', false],
    // 通配规则 *.ck / *.bd：规则主体（abc.ck）自身也是后缀；
    // www.abc.ck 的公共后缀是 abc.ck，eTLD+1 即 www.abc.ck
    ['abc.ck', 'abc.ck', 'abc.ck', true],
    ['www.abc.ck', 'abc.ck', 'www.abc.ck', false],
    ['a.www.abc.ck', 'abc.ck', 'www.abc.ck', false],
    ['x.com.bd', 'com.bd', 'x.com.bd', false],
    ['a.b.x.com.bd', 'com.bd', 'x.com.bd', false],
    // IP
    ['127.0.0.1', '127.0.0.1', '127.0.0.1', false],
    ['[::1]', '[::1]', '[::1]', false],
  ];
  for (const [host, suffix, regd, isSuffix] of cases) {
    await t.test(host, () => {
      const info = siteInfo(host, DEFAULT_SUFFIX_REGISTRY);
      assert.equal(info.publicSuffix, suffix);
      assert.equal(info.registrableDomain, regd);
      assert.equal(info.hostIsPublicSuffix, isSuffix);
    });
  }
});

test('isSameSite / siteKey（schemeful）', () => {
  const R = DEFAULT_SUFFIX_REGISTRY;
  assert.equal(
    isSameSite(new URL('https://example.com/'), new URL('https://a.example.com/p'), R),
    true,
  );
  assert.equal(
    isSameSite(new URL('https://example.com/'), new URL('http://example.com/'), R),
    false, // scheme 不同
  );
  assert.equal(
    isSameSite(new URL('https://a.com/'), new URL('https://b.com/'), R),
    false,
  );
  assert.equal(
    isSameSite(
      new URL('https://example.co.uk/'),
      new URL('https://sub.example.co.uk/'),
      R,
    ),
    true,
  );
  assert.equal(
    isSameSite(new URL('https://a.github.io/'), new URL('https://b.github.io/'), R),
    false, // github.io 在 exact 列表中
  );
  // ws/wss 映射到 http/https
  assert.equal(
    siteKey(new URL('wss://example.com/'), R),
    'https://example.com',
  );
});

// ------------------------------------------------------------------
// 存储时的域名策略
// ------------------------------------------------------------------

test('host-only：无 Domain 属性仅精确主机发送', () => {
  const j = jar();
  const r = j.setCookie({ url: new URL('https://sub.example.com/') }, 'a=1');
  assert.equal(r.status, 'stored');
  assert.equal(
    j.getCookieHeader({ url: new URL('https://sub.example.com/') }),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }),
    null,
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://other.sub.example.com/') }),
    null,
  );
});

test('Domain 属性：子域可发送，末尾点规范化一致', () => {
  const j = jar();
  const r1 = j.setCookie(
    { url: new URL('https://sub.example.com/') },
    'a=1; Domain=EXAMPLE.com.',
  );
  assert.equal(r1.status, 'stored');
  if (r1.status === 'stored') {
    assert.equal(r1.cookie.domain, 'example.com');
    assert.equal(r1.cookie.hostOnly, false);
  }
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://deep.sub.example.com/') }),
    'a=1',
  );
});

test('非法 Domain 拒绝（表驱动）', async (t) => {
  const bad = [
    'other.com',
    'notexample.com',
    '.com',
    'sub..example.com',
    '-bad.example.com',
    'exämple.com',
  ];
  for (const d of [...bad]) {
    await t.test(d, () => {
      const j = jar();
      const r = j.setCookie(
        { url: new URL('https://sub.example.com/') },
        `a=1; Domain=${d}`,
      );
      // 不归属的合法域名 → host-only 回退；非法字符串 → invalid-domain
      if (d === 'other.com' || d === 'notexample.com' || d === '.com') {
        // .com 经过 trim 后是 ".com" → normalizeDomain 拒绝
        if (d === '.com') {
          assert.equal(r.status, 'rejected');
          if (r.status === 'rejected') assert.equal(r.reason, 'invalid-domain');
        } else {
          assert.equal(r.status, 'stored');
          if (r.status === 'stored') assert.equal(r.cookie.hostOnly, true);
        }
      } else {
        assert.equal(r.status, 'rejected');
        if (r.status === 'rejected') assert.equal(r.reason, 'invalid-domain');
      }
    });
  }
});

test('公共后缀越权拒绝', () => {
  const j = jar();
  let r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Domain=com',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'public-suffix');

  r = j.setCookie(
    { url: new URL('https://example.co.uk/') },
    'a=1; Domain=co.uk',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'public-suffix');

  // 通配规则：Domain=abc.ck（其自身是公共后缀）
  r = j.setCookie(
    { url: new URL('https://x.abc.ck/') },
    'a=1; Domain=abc.ck',
  );
  assert.equal(r.status, 'rejected');
  if (r.status === 'rejected') assert.equal(r.reason, 'public-suffix');
});

test('公共后缀主机上仍可写 host-only cookie', () => {
  const j = jar();
  // 响应主机本身是 com（少见但策略上允许 host-only）
  const r = j.setCookie({ url: new URL('https://com/') }, 'a=1');
  assert.equal(r.status, 'stored');
  assert.equal(
    j.getCookieHeader({ url: new URL('https://com/') }),
    'a=1',
  );
});

test('IP 字面量：Domain 属性被忽略，host-only', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://127.0.0.1/') },
    'a=1; Domain=127.0.0.1',
  );
  assert.equal(r.status, 'stored');
  if (r.status === 'stored') assert.equal(r.cookie.hostOnly, true);
});

test('末尾点来源主机与无点 Domain 视为同一域', () => {
  const j = jar();
  // 标准 URL 一般会规整末尾点；用无点主机直接写 Domain
  const r = j.setCookie(
    { url: new URL('https://foo.example.com/') },
    'a=1; Domain=example.com; Path=/',
  );
  assert.equal(r.status, 'stored');
  assert.equal(
    j.getCookieHeader({ url: new URL('https://foo.example.com/') }),
    'a=1',
  );
});
