/**
 * 默认路径、路径匹配（RFC 6265 §5.1.4）与站点键（schemeful site）。
 */
import { isIPLiteral, canonicalizeRequestHost } from './domain.js';
import { registrableDomain } from './public-suffix.js';

/** RFC 6265 §5.1.4：由请求 URI 推导默认 cookie-path。 */
export function defaultPath(url: URL): string {
  const uriPath = url.pathname;
  // 6. 若路径为空或不以 "/" 开头，默认 "/"。
  if (uriPath === '' || !uriPath.startsWith('/')) {
    return '/';
  }
  // 仅根 "/"：默认 "/"。
  if (uriPath.length === 1) {
    return '/';
  }
  // 去掉最后一段。
  const lastSlash = uriPath.lastIndexOf('/');
  const trimmed = uriPath.slice(0, lastSlash);
  return trimmed === '' ? '/' : trimmed;
}

/** RFC 6265 §5.1.4 路径匹配（大小写敏感）。 */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  if (cookiePath.endsWith('/')) {
    return true;
  }
  return requestPath.charAt(cookiePath.length) === '/';
}

export const SECURE_SCHEMES = new Set(['https:', 'wss:']);

export function isSecureScheme(scheme: string): boolean {
  return SECURE_SCHEMES.has(scheme.toLowerCase());
}

/**
 * 推导 URL 的站点键（"scheme://regdomain"）。
 * IP 字面量与单标签主机（localhost）用主机本身代替可注册域。
 */
export function siteKey(url: URL): string {
  const scheme = url.protocol.toLowerCase();
  const host = canonicalizeRequestHost(url.hostname);
  if (host === null) {
    return `${scheme}//`;
  }
  if (isIPLiteral(host)) {
    return `${scheme}//${host}`;
  }
  const reg = registrableDomain(host);
  return `${scheme}//${reg ?? host}`;
}

/** 安全方法（RFC 6265bis §5.2 顶层导航 Lax 放行名单）。 */
const SAFE_METHODS = new Set(['get', 'head', 'options', 'trace']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toLowerCase());
}
