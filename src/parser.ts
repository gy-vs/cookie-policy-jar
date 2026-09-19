/**
 * Set-Cookie 头解析（RFC 6265 §5.2 的属性收集阶段）。
 *
 * 这里只做语法切分与取值，不做来源校验；域名规范化、域匹配等在 jar 内完成。
 */
import type { SameSite } from './types.js';
import { parseDate } from './date.js';

/** RFC 6265 §4.1.1 的 token 字符集合（%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E）。 */
export function isTokenChar(code: number): boolean {
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x2b) ||
    (code >= 0x2d && code <= 0x3a) ||
    (code >= 0x3c && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  );
}

/** cookie-octet：token 字符外加 DQUOTE（引号内的值），不含空白、分号、逗号。 */
function isCookieOctet(code: number): boolean {
  return code === 0x22 || isTokenChar(code);
}

function onlyAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7e) {
      return false;
    }
  }
  return true;
}

/** 名称必须是非空 token。 */
export function isValidCookieName(name: string): boolean {
  if (name.length === 0 || !onlyAscii(name)) {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    if (!isTokenChar(name.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

/** 值由 cookie-octet 组成（允许为空）。 */
export function isValidCookieValue(value: string): boolean {
  if (!onlyAscii(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!isCookieOctet(value.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  /** Max-Age（秒，可能为负）；未出现或语法非法为 null。 */
  readonly maxAge: number | null;
  /** Expires（UTC 毫秒）；未出现或解析失败为 null。 */
  readonly expires: number | null;
  /** Domain 属性原始值（仅 trim），缺省为 null。 */
  readonly domain: string | null;
  /** Path 属性值，缺省为 null。 */
  readonly path: string | null;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: SameSite;
  readonly partitioned: boolean;
}

/**
 * 解析单条 Set-Cookie 字符串。语法不合法（名称/值字符不合法、缺少 '='）返回 null。
 */
export function parseSetCookie(input: string): ParsedCookie | null {
  if (input.includes('\r') || input.includes('\n')) {
    return null;
  }

  // 1. 第一个分号之前是 name=value 对。
  const firstSemicolon = input.indexOf(';');
  const nameValuePair =
    firstSemicolon === -1 ? input : input.slice(0, firstSemicolon);
  const remaining =
    firstSemicolon === -1 ? '' : input.slice(firstSemicolon + 1);

  const equalsPos = nameValuePair.indexOf('=');
  if (equalsPos === -1) {
    return null;
  }
  const name = nameValuePair.slice(0, equalsPos).trim();
  const value = nameValuePair.slice(equalsPos + 1).trim();
  if (!isValidCookieName(name) || !isValidCookieValue(value)) {
    return null;
  }

  let maxAge: number | null = null;
  let expires: number | null = null;
  let domain: string | null = null;
  let path: string | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = 'Lax';
  let partitioned = false;

  let expiresConsumed = false;
  let pathConsumed = false;

  for (const rawAttribute of remaining.length === 0 ? [] : remaining.split(';')) {
    const attrEquals = rawAttribute.indexOf('=');
    const attrName =
      (attrEquals === -1 ? rawAttribute : rawAttribute.slice(0, attrEquals))
        .trim()
        .toLowerCase();
    const attrValue =
      attrEquals === -1 ? '' : rawAttribute.slice(attrEquals + 1).trim();
    if (attrName === '') {
      continue;
    }

    switch (attrName) {
      case 'expires': {
        // 第一个可解析的 Expires 生效；后续的 Expires 忽略。
        if (!expiresConsumed) {
          const parsed = parseDate(attrValue);
          if (parsed !== null) {
            expires = parsed;
          }
          expiresConsumed = true;
        }
        break;
      }
      case 'max-age': {
        // Max-Age 出现且值合法即覆盖 Expires；最后一个合法值生效。
        if (/^-?\d+$/.test(attrValue)) {
          maxAge = Number(attrValue);
        }
        break;
      }
      case 'domain': {
        if (attrValue !== '') {
          domain = attrValue;
        }
        break;
      }
      case 'path': {
        // 第一个 Path 生效。
        if (!pathConsumed) {
          path = attrValue;
          pathConsumed = true;
        }
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        switch (attrValue.toLowerCase()) {
          case 'strict':
            sameSite = 'Strict';
            break;
          case 'lax':
            sameSite = 'Lax';
            break;
          case 'none':
            sameSite = 'None';
            break;
          default:
            // 无法识别的值按 Lax（bis 默认行为）。
            sameSite = 'Lax';
        }
        break;
      }
      case 'partitioned':
        partitioned = true;
        break;
      default:
        // 未知属性忽略。
        break;
    }
  }

  return {
    name,
    value,
    maxAge,
    expires,
    domain,
    path,
    secure,
    httpOnly,
    sameSite,
    partitioned,
  };
}
