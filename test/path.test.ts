import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, defaultPath } from '../src/index.js';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);
const jar = () => new CookieJar({ now: () => T });

test('defaultPath 表驱动', async (t) => {
  const cases: [string, string][] = [
    ['/', '/'],
    ['/index.html', '/'],
    ['/docs/', '/docs'],
    ['/docs/guide', '/docs'],
    ['/a/b/c', '/a/b'],
    ['', '/'],
    ['noslash', '/'],
  ];
  for (const [pathname, expected] of cases) {
    await t.test(pathname, () => {
      const u = new URL('https://example.com' + (pathname === '' ? '' : pathname));
      assert.equal(defaultPath(u), expected);
    });
  }
});

test('默认 Path 来自响应 URL 的目录', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/docs/guide/chapter') },
    'a=1',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.path, '/docs/guide');

  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/docs/guide/x') }),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/docs/') }),
    null,
  );
});

test('Path 属性：显式、缺省回退（表驱动）', async (t) => {
  const cases: [string, string][] = [
    // [Set-Cookie 的 Path 片段, 期望存储 path]
    ['Path=/app', '/app'],
    ['Path=/app/', '/app/'],
    ['Path=relative', '/'], // 非绝对路径 → 默认路径（URL 是 /）
    ['Path=', '/'],
    ['', '/'],
  ];
  for (const [attr, expected] of cases) {
    await t.test(attr || '(none)', () => {
      const j = jar();
      const header = `a=1${attr ? '; ' + attr : ''}`;
      const r = j.setCookie({ url: new URL('https://example.com/') }, header);
      assert.equal(r.status, 'stored');
      if (r.status !== 'stored') return;
      assert.equal(r.cookie.path, expected);
    });
  }
});

test('path-match 边界', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/foo');
  // 命中：全等、前缀+斜杠
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/foo') }),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/foo/bar') }),
    'a=1',
  );
  // 不命中：纯字符串前缀 /foobar
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/foobar') }),
    null,
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/other') }),
    null,
  );
});

test('发送排序：path 长度降序，再按创建序', () => {
  const j = jar();
  // 故意乱序写入
  j.setCookie({ url: new URL('https://example.com/') }, 'root=1; Path=/');
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/a');
  j.setCookie(
    { url: new URL('https://example.com/') },
    'deep=1; Path=/a/b/c',
  );
  j.setCookie(
    { url: new URL('https://example.com/') },
    'mid=1; Path=/a/b',
  );

  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/a/b/c/page') }),
    'deep=1; mid=1; a=1; root=1',
  );
});

test('同路径同长度按创建序稳定排序', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/foo') }, 'x=1');
  j.setCookie({ url: new URL('https://example.com/foo') }, 'y=2');
  j.setCookie({ url: new URL('https://example.com/foo') }, 'z=3');
  // 响应路径 /foo → 默认 Path=/，三条同长路径按创建序
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/foo') }),
    'x=1; y=2; z=3',
  );
});

test('同名不同路径的 Cookie 都会发送且按路径排序', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'sid=root; Path=/');
  j.setCookie({ url: new URL('https://example.com/') }, 'sid=app; Path=/app');
  j.setCookie(
    { url: new URL('https://example.com/') },
    'sid=deep; Path=/app/deep',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/app/deep/x') }),
    'sid=deep; sid=app; sid=root',
  );
});

test('覆盖更新保留原始创建顺序', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'first=1; Path=/a');
  j.setCookie({ url: new URL('https://example.com/') }, 'second=2; Path=/a');
  // 更新 first：值变化，creationIndex 不应改变
  const up = j.setCookie(
    { url: new URL('https://example.com/') },
    'first=999; Path=/a',
  );
  assert.equal(up.status, 'stored');
  if (up.status !== 'stored') return;
  assert.equal(up.replaced, true);
  assert.equal(up.cookie.creationIndex, 0);

  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/a') }),
    'first=999; second=2',
  );
});

test('Path 不同则视为不同记录（覆盖不发生）', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1; Path=/x');
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=2; Path=/y',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.replaced, false);
  assert.equal(j.size, 2);
});
