/**
 * HTTP 日期解析，严格按 RFC 6265 §5.1.1 实现。
 *
 * 该算法对历史上各种 expires 格式容错：先按分隔符切成 token，
 * 再按内容分别识别“时间 / 日 / 月 / 年”，无法识别或字段缺失则失败。
 */

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;

// delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-79
// 注意：连字符 '-'(%x2D) 是分隔符之外吗？否——%x20-2F 包含 '-'，
// 但 "06-Nov-94" 作为一个 token 时数字分支会因非纯数字而忽略它。
// delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-79。
// 冒号不是分隔符（H:M:S 必须保持为一个 token）。
// 对通配公共后缀规则而言，匹配标签必须位于基后缀左侧且左侧至少还有一个标签。
const DELIMITER = /[\t !"#$%&'()*+,\x2D./;<=>?@[\\\]^_`{|}~]+/g;
/**
 * 解析 cookie 日期串。成功返回相对 1970-01-01 UTC 的毫秒时间戳，失败返回 null。
 */
export function parseDate(input: string): number | null {
  // 1. 按分隔符切成 token（RFC §5.1.1 的 delimiter 集合）。
  const tokens = input.split(DELIMITER).filter((t) => t.length > 0);

  let hour: number | null = null;
  let minute: number | null = null;
  let second: number | null = null;
  let dayOfMonth: number | null = null;
  let month: number | null = null;
  let year: number | null = null;

  for (const token of tokens) {
    // 时间 token：含冒号，形如 H:M:S，共 2 或 3 段、每段 1~2 位数字。
    if (token.includes(':')) {
      if (hour !== null) {
        continue;
      }
      const parts = token.split(':');
      if (
        (parts.length !== 2 && parts.length !== 3) ||
        parts.some((p) => !/^\d{1,2}$/.test(p))
      ) {
        return null;
      }
      const [h, m, s] = parts.map(Number) as [number, number, ...number[]];
      if (h > 23 || m > 59 || (parts.length === 3 && (s as number) > 59)) {
        return null;
      }
      hour = h;
      minute = m;
      second = parts.length === 3 ? (s as number) : 0;
      continue;
    }

    if (/^\d+$/.test(token)) {
      if (token.length <= 2) {
        // 1~2 位数字：日
        if (dayOfMonth === null) {
          dayOfMonth = Number(token);
        }
      } else if (token.length === 3) {
        // 3 位数字：年
        if (year === null) {
          year = Number(token);
        }
      } else if (token.length === 4) {
        // 4 位数字：优先解释成年，其次日
        if (year === null) {
          year = Number(token);
        } else if (dayOfMonth === null) {
          dayOfMonth = Number(token);
        }
      }
      // 其余长度的纯数字忽略
      continue;
    }

    // 月份 token：必须全部由非数字字符组成（alpha-token，如 "Nov"、
    // "September"、"Tues"），取前三个字母识别月份。"Sunday" 的前缀
    // "sun" 不是月份名，因而被忽略，不会抢占月份位。
    if (!/[0-9]/.test(token) && month === null) {
      const prefix = token.slice(0, 3).toLowerCase();
      const monthIndex = MONTHS.indexOf(prefix as (typeof MONTHS)[number]);
      if (monthIndex !== -1) {
        month = monthIndex;
      }
    }
  }

  // 任一字段缺失即失败。
  if (
    hour === null ||
    minute === null ||
    second === null ||
    dayOfMonth === null ||
    month === null ||
    year === null
  ) {
    return null;
  }

  // RFC 的范围检查：年份必须 >= 1601，日必须在 1..31。
  if (dayOfMonth < 1 || dayOfMonth > 31 || year < 1601) {
    return null;
  }
  if (year >= 0 && year <= 69) {
    year += 2000;
  } else if (year >= 70 && year <= 99) {
    year += 1900;
  }

  const result = Date.UTC(year, month, dayOfMonth, hour, minute, second);
  // 拒绝规范化后跑出当月的日期（如 2 月 31 日）。
  if (new Date(result).getUTCMonth() !== month) {
    return null;
  }
  return result;
}
