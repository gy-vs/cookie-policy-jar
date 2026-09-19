import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieDate, parseMaxAge, CookieJar } from '../src/index.js';

const T = Date.UTC(2026, 0, 15, 12, 0, 0);

interface DateCase {
  only?: boolean;
  input: string;
  expected: number | null;
}

const DATE_CASES: DateCase[] = [
  // RFC 7231 IMF-fixdate
  { input: 'Sun, 06 Nov 1994 08:49:37 GMT', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // RFC 850 风格 + 两位年份（>=70 → 1900+）
  { input: 'Tuesday, 09-Nov-94 08:49:37 GMT', expected: Date.UTC(1994, 10, 9, 8, 49, 37) },
  // asctime 风格
  { input: 'Sun Nov  6 08:49:37 1994', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 两位年份 00-69 → 2000+
  { input: 'Thu, 01 Jan 69 00:00:00 GMT', expected: Date.UTC(2069, 0, 1, 0, 0, 0) },
  { input: 'Thu, 01 Jan 70 00:00:00 GMT', expected: Date.UTC(1970, 0, 1, 0, 0, 0) },
  { input: 'Thu, 01 Jan 00 00:00:00 GMT', expected: Date.UTC(2000, 0, 1, 0, 0, 0) },
  // 没有星期也没有逗号
  { input: '06 Nov 1994 08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 非法输入
  { input: '', expected: null },
  { input: 'not a date', expected: null },
  { input: 'Sun, 06 Nov 1994 25:49:37 GMT', expected: null },
  { input: 'Sun, 06 Nov 1994 08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 2 月 31 日不存在
  { input: 'Mon, 31 Feb 2020 12:00:00 GMT', expected: null },
  // 日超出范围
  { input: 'Thu, 32 Jan 2020 12:00:00 GMT', expected: null },
  // 年份 < 1601
  { input: 'Thu, 01 Jan 1599 00:00:00 GMT', expected: null },
  // 重复月份
  { input: 'Jan Jan 06 1994 08:49:37', expected: null },
  // 未知 alpha token（GMT 等时区）应被忽略
  { input: 'Wed, 21 Oct 2015 07:28:00 GMT', expected: Date.UTC(2015, 9, 21, 7, 28, 0) },
  { input: 'Wed, 21 Oct 2015 07:28:00 UTC', expected: Date.UTC(2015, 9, 21, 7, 28, 0) },
  // 缺少时间 / 日 / 月 / 年
  { input: '06 Nov 1994', expected: null },
  { input: 'Nov 1994 08:49:37', expected: null },
  // 毫秒无关，秒级解析
  { input: 'Thu, 15 Jan 2026 12:00:00 GMT', expected: T },
];

test('parseCookieDate 表驱动', async (t) => {
  for (const c of DATE_CASES) {
    await t.test(JSON.stringify(c.input), () => {
      const d = parseCookieDate(c.input);
      assert.equal(d === null ? null : d.getTime(), c.expected);
    });
  }
});

test('parseMaxAge', async (t) => {
  const cases: [string | undefined, number | null][] = [
    ['0', 0],
    ['60', 60],
    ['-1', -1],
    ['  30  ', 30],
    ['1.5', null],
    ['abc', null],
    ['', null],
    [undefined, null],
    ['0x10', null],
  ];
  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.equal(parseMaxAge(input), expected);
    });
  }
});

function jar(): CookieJar {
  return new CookieJar({ now: () => T });
}

test('Max-Age 优先于 Expires（即使 Expires 是过去时间）', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Max-Age=10; Expires=Mon, 01 Jan 2024 00:00:00 GMT',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.expiresAt, T + 10_000);
});

test('Expires 过去时间 → 删除；不存在的键 removed=false', () => {
  const j = jar();
  const r1 = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Expires=Mon, 01 Jan 2024 00:00:00 GMT',
  );
  assert.equal(r1.status, 'deleted');
  if (r1.status !== 'deleted') return;
  assert.equal(r1.removed, false);
  assert.equal(j.size, 0);
});

test('Max-Age=0 删除已有记录', () => {
  const j = jar();
  j.setCookie({ url: new URL('https://example.com/') }, 'a=1');
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=2; Max-Age=0',
  );
  assert.equal(r.status, 'deleted');
  if (r.status !== 'deleted') return;
  assert.equal(r.removed, true);
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }),
    null,
  );
});

test('非法 Max-Age 被忽略，回落到 Expires', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Max-Age=soon; Expires=Wed, 15 Jan 2026 13:00:00 GMT',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.expiresAt, T + 3600_000);
});

test('非法 Expires 被忽略 → 会话 Cookie', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Expires=whenever',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.expiresAt, Infinity);
});

test('过期 Cookie 不发送（注入时间推进）', () => {
  const j = jar();
  j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Expires=Wed, 15 Jan 2026 13:00:00 GMT',
  );
  const before = { now: T + 3599_000 };
  const after = { now: T + 3600_000 };
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }, before),
    'a=1',
  );
  assert.equal(
    j.getCookieHeader({ url: new URL('https://example.com/') }, after),
    null,
  );
});

test('Expires 钳制到 9999 年上限', () => {
  const j = jar();
  const r = j.setCookie(
    { url: new URL('https://example.com/') },
    'a=1; Expires=Wed, 01 Jan 99999 00:00:00 GMT',
  );
  assert.equal(r.status, 'stored');
  if (r.status !== 'stored') return;
  assert.equal(r.cookie.expiresAt, Date.UTC(9999, 11, 31, 23, 59, 59));
});
