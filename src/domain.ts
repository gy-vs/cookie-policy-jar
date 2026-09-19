/**
 * 域名规范化、域匹配与站点（site）计算。
 *
 * 规范化规则（对请求主机与 Domain 属性一视同仁）：
 *   1. ASCII 小写；
 *   2. 去除唯一的末尾根点（FQDN trailing dot），"example.com." 与
 *      "example.com" 视为同一主机；
 *   3. 非 ASCII 字符一律拒绝（URL 主机名由标准 URL 完成 punycode 转码，
 *      Domain 属性出现非 ASCII 时判为非法 Domain）。
 */
import type { SuffixRegistry } from './types.js';

const LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * 规范化主机名 / Domain 属性值。返回 null 表示语法非法。
 * 调用前 Domain 属性的前导点应已剥离。
 */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  // 仅允许一个末尾根点
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (d.length === 0 || d.length > 253) return null;
  if (/[^a-z0-9.\-]/.test(d)) return null;
  if (d.startsWith('.') || d.includes('..')) return null;

  const labels = d.split('.');
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return null;
  }
  return d;
}

/** 取标准 URL 的主机名并做同样的末尾点规范化。 */
export function requestHost(url: URL): string {
  let h = url.hostname.toLowerCase();
  // IPv6 在 WHATWG URL 中带方括号，不做点处理
  if (h.startsWith('[')) return h;
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export function isIpLiteral(host: string): boolean {
  if (IPV4_RE.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return false;
}

/** RFC 6265 5.1.3 domain-match。 */
export function domainMatch(requestHost: string, cookieDomain: string): boolean {
  if (requestHost === cookieDomain) return true;
  return requestHost.endsWith('.' + cookieDomain);
}

export interface SiteInfo {
  /** 不可再下放的公共后缀（eTLD）。 */
  publicSuffix: string;
  /** eTLD+1；IP 或后缀本身即为主机时退化为主机本身。 */
  registrableDomain: string;
  /** 主机是否本身就是公共后缀。 */
  hostIsPublicSuffix: boolean;
}

/**
 * 依据后缀注册表计算站点信息。
 * 支持 exact 与 wildcard（"*.<body>"）两类规则，不处理例外规则。
 */
export function siteInfo(host: string, registry: SuffixRegistry): SiteInfo {
  if (isIpLiteral(host)) {
    return {
      publicSuffix: host,
      registrableDomain: host,
      hostIsPublicSuffix: false,
    };
  }

  const labels = host.split('.');
  let publicSuffix = labels[labels.length - 1] ?? host;

  // 从最长候选向下找，保证长规则优先（co.uk 胜过 uk 默认规则）
  for (let n = labels.length; n >= 1; n--) {
    const candidate = labels.slice(labels.length - n).join('.');
    if (registry.exact.has(candidate)) {
      publicSuffix = candidate;
      break;
    }
    if (n >= 2) {
      const wildcardBody = labels.slice(labels.length - (n - 1)).join('.');
      if (registry.wildcard.has(wildcardBody)) {
        // 规则形如 *.<wildcardBody>，命中的公共后缀要带上通配那一级
        publicSuffix = candidate;
        break;
      }
    }
  }

  const suffixLabels = publicSuffix.split('.');
  const extra = labels.length - suffixLabels.length;
  const registrableDomain =
    extra >= 1
      ? labels
          .slice(labels.length - (suffixLabels.length + 1))
          .join('.')
      : host;

  return {
    publicSuffix,
    registrableDomain,
    hostIsPublicSuffix: extra === 0,
  };
}

function schemeOf(url: URL): string {
  const s = url.protocol.replace(':', '').toLowerCase();
  if (s === 'ws') return 'http';
  if (s === 'wss') return 'https';
  return s;
}

/** 站点键：scheme 规范化后 + eTLD+1，用于同站判断与分区键。 */
export function siteKey(url: URL, registry: SuffixRegistry): string {
  const host = requestHost(url);
  const { registrableDomain } = siteInfo(host, registry);
  return `${schemeOf(url)}://${registrableDomain}`;
}

/** schemeful same-site：scheme 与 registrable domain 均相同。 */
export function isSameSite(a: URL, b: URL, registry: SuffixRegistry): boolean {
  return siteKey(a, registry) === siteKey(b, registry);
}
