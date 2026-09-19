/**
 * Set-Cookie 头解析、Cookie 日期解析、默认 Path 与安全来源判定。
 * 不依赖任何第三方 Cookie/URL 解析库。
 */
import type { SameSiteMode } from './types.js';

/**
 * 按 ";" 切分第一条 Set-Cookie 头并解析。
 * 返回 null 表示连最基本的 name=value 都不成立。
 */
export interface ParsedSetCookie {
  name: string;
  value: string;
  /** 小写属性名 -> 原样尾部字符串（已 trim）。 */
  attributes: Map<string, string>;
}

export function parseSetCookie(header: string): ParsedSetCookie | null {
  if (typeof header !== 'string' || header.length === 0) return null;

  const parts = header.split(';');
  const first = parts[0];
  if (first === undefined) return null;

  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name.length === 0) return null;
  // RFC 6265：name 不得含控制字符、空白与分号
  if (/[\x00-\x1f\x7f\s;=]/.test(name)) return null;
  // value 去掉成对包裹的双引号后不得含控制字符、空白、分号或反斜杠
  let v = value;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  if (/[\x00-\x1f\x7f\s;\\"]/.test(v)) return null;

  const attributes = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (segment === undefined) continue;
    const idx = segment.indexOf('=');
    const rawName =
      idx === -1 ? segment.trim().toLowerCase() : segment.slice(0, idx).trim().toLowerCase();
    const rawValue = idx === -1 ? '' : segment.slice(idx + 1).trim();
    if (rawName.length === 0) continue;
    // 同名属性取第一次出现（RFC 6265 5.2 对单头的要求）
    if (!attributes.has(rawName)) attributes.set(rawName, rawValue);
  }

  return { name, value: v, attributes };
}

/**
 * RFC 6265 5.1.1 Cookie 日期解析。无法解析返回 null。
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseCookieDate(input: string): Date | null {
  const tokens = input.split(/[\x09\x20-\x2f\x3b\x40\x60\x7b-\x7e]+/);

  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let timeFound = false;

  for (const token of tokens) {
    if (token === '') continue;

    // hh:mm:ss 时间
    if (!timeFound && token.includes(':')) {
      const time = token.split(':');
      if (time.length !== 3) continue;
      const h = Number(time[0]);
      const m = Number(time[1]);
      const s = Number(time[2]);
      if (
        time[0]!.length !== 2 ||
        time[1]!.length !== 2 ||
        time[2]!.length !== 2 ||
        !Number.isInteger(h) ||
        !Number.isInteger(m) ||
        !Number.isInteger(s) ||
        h < 0 ||
        h > 23 ||
        m < 0 ||
        m > 59 ||
        s < 0 ||
        s > 59
      ) {
        return null;
      }
      hour = h;
      minute = m;
      second = s;
      timeFound = true;
      continue;
    }

    // 月份（英文缩写前缀）
    if (/^[a-z]+$/i.test(token)) {
      const m = MONTHS[token.slice(0, 3).toLowerCase()];
      if (m === undefined) {
        // 时区等未知 alpha token 忽略
        continue;
      }
      if (month !== null) return null;
      month = m;
      continue;
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (token.length <= 2) {
        if (day === null) day = n;
        else if (year === null) year = n;
        else return null;
      } else {
        if (year === null) year = n;
        else return null;
      }
      continue;
    }

    // 其余 token 忽略
  }

  if (!timeFound || day === null || month === null || year === null) {
    return null;
  }
  if (day < 1 || day > 31) return null;
  if (year >= 0 && year <= 69) year += 2000;
  else if (year >= 70 && year <= 99) year += 1900;
  if (year < 1601) return null;

  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  // 拒绝不存在的日期（如 2 月 31 日）
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * 解析 Max-Age：仅接受可选负号 + 纯数字（RFC 中为 1*DIGIT，浏览器普遍接受负值）。
 */
export function parseMaxAge(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^-?\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export function parseSameSite(raw: string | undefined): SameSiteMode {
  switch (raw?.toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'none':
      return 'None';
    case 'lax':
    default:
      // 缺省或无法识别均按 Lax
      return 'Lax';
  }
}

/** RFC 6265 5.1.4 默认 Path。 */
export function defaultPath(url: URL): string {
  const uriPath = url.pathname;
  if (uriPath === '' || !uriPath.startsWith('/')) return '/';
  if (uriPath === '/') return '/';
  const lastSlash = uriPath.lastIndexOf('/');
  if (lastSlash === 0) return '/';
  return uriPath.slice(0, lastSlash);
}

const LOOPBACK_V4 = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/;

/**
 * 安全来源判定。localhost / 回环地址按 Secure Contexts 视为潜在可信；
 * 调用方可通过 treatLocalhostAsSecure 关闭。
 */
export function isPotentiallyTrustworthy(
  url: URL,
  treatLocalhostAsSecure: boolean,
): boolean {
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (scheme === 'https' || scheme === 'wss') return true;
  if (treatLocalhostAsSecure) {
    let h = url.hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (LOOPBACK_V4.test(h)) return true;
    if (h === '::1' || h === '[::1]') return true;
  }
  return false;
}
