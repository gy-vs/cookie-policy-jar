/**
 * 表驱动测试：HTTP 日期解析（RFC 6265 §5.1.1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../src/date.js';

interface DateCase {
  input: string;
  /** 期望的 UTC 毫秒；null 表示必须解析失败。 */
  expected: number | null;
}

const CASES: DateCase[] = [
  // RFC 1123 主流形式
  { input: 'Sun, 06 Nov 1994 08:49:37 GMT', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 无星期、无 GMT
  { input: '06 Nov 1994 08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // RFC 850：日/月/年由连字符连成一个 token。RFC 6265 的分词算法会忽略
  // 该混合 token，导致日与年缺失 -> 解析失败（RFC 6265 有意如此）。
  { input: 'Sunday, 06-Nov-94 08:49:37 GMT', expected: null },
  // 破折号形式但各字段分开时可解析
  { input: '06 Nov 1994 08-49-37', expected: null }, // 时间必须含冒号
  { input: 'Sun, 06-Nov 1994 08:49:37 GMT', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // asctime
  { input: 'Sun Nov  6 08:49:37 1994', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 两位数 token 按 RFC 只能解释为“日”：独立的 25 不会成为年，
  // 因此该串缺少年份 -> 失败（RFC 6265 算法的已知局限）。
  { input: 'Wed, 01 Jan 25 00:00:00 GMT', expected: null },
  // RFC 850 的混合 token 06-Nov-94 同样无法解析（见上）。
  // 四位年份正常
  { input: 'Wed, 01 Jan 2025 00:00:00 GMT', expected: Date.UTC(2025, 0, 1) },
  // 独立两位 token 只能是日，故 70 不能作为年份（缺少年字段 -> 失败）。
  { input: 'Thu, 31 Dec 70 23:59:59 GMT', expected: null },
  // 缺省秒
  { input: 'Tue, 15 Jan 2019 10:30 GMT', expected: Date.UTC(2019, 0, 15, 10, 30, 0) },
  // 三位年份 < 1601：RFC 要求失败
  { input: 'Mon, 01 Jan 999 00:00:00 GMT', expected: null },
  // 1601 是合法下限
  { input: 'Fri, 01 Jan 1601 00:00:00 GMT', expected: Date.UTC(1601, 0, 1) },
  // 奇怪分隔符
  { input: '06/Nov/1994 08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  { input: '06-Nov-1994\t08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 月份大小写
  { input: '06 NOV 1994 08:49:37', expected: Date.UTC(1994, 10, 6, 8, 49, 37) },
  // 月份前缀带额外字母（Sept）
  { input: '06 September 1994 08:49:37', expected: Date.UTC(1994, 8, 6, 8, 49, 37) },

  // 失败用例
  { input: '', expected: null },
  { input: 'not a date', expected: null },
  { input: '06 Nov 1994', expected: null }, // 缺时间
  { input: '25:00:00 06 Nov 1994', expected: null }, // 小时越界
  { input: '08:60:00 06 Nov 1994', expected: null }, // 分钟越界
  { input: '08:49:61 06 Nov 1994', expected: null }, // 秒越界
  { input: '32 Nov 1994 08:49:37', expected: null }, // 日越界
  { input: '31 Feb 2000 08:49:37', expected: null }, // 日期溢出当月
  { input: '29 Feb 1999 08:49:37', expected: null }, // 非闰年 2 月 29
  { input: '06 Xyz 1994 08:49:37', expected: null }, // 未知月份
  { input: '06 Nov 1500 08:49:37', expected: null }, // 年份 < 1601
];

test('parseDate table', () => {
  for (const c of CASES) {
    assert.equal(
      parseDate(c.input),
      c.expected,
      `parseDate(${JSON.stringify(c.input)})`,
    );
  }
});
