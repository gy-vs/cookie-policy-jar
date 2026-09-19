/**
 * 域名规范化与域匹配规则。
 *
 * - 全部按 ASCII 小写比较（IDN 通过 UTS #46/IDNA 转 A 标签）。
 * - 忽略末尾根点："example.com." 与 "example.com" 视为同一个域。
 * - 域匹配为“相同域或是其子域”（不带前导通配点）。
 */
import { domainToASCII } from 'node:url';

const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 从 URL 主机中去掉 IPv6 方括号，得到用于比较的主机字符串（小写）。 */
export function unwrapHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function isIPv4Literal(host: string): boolean {
  const match = IPV4.exec(host);
  if (!match) {
    return false;
  }
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

export function isIPLiteral(host: string): boolean {
  if (isIPv4Literal(host)) {
    return true;
  }
  // 去掉方括号后含冒号即视为 IPv6。
  const inner = unwrapHost(host);
  return inner.includes(':');
}

/**
 * 校验并规范化一个点分域名：转 ASCII、小写、去末尾点、逐标签 LDH 校验。
 * 不接受 IP 字面量。失败返回 null。
 */
export function canonicalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return null;
  }
  // 去掉单个末尾根点（多个点交给后续校验拒绝）。
  if (value.endsWith('.')) {
    value = value.slice(0, -1);
  }
  if (value.length === 0 || value.endsWith('.')) {
    return null;
  }
  if (value.length > 253) {
    return null;
  }

  // 先做 IDNA 处理（Unicode -> A 标签），再对 ASCII 结果逐标签校验。
  let ascii: string;
  try {
    ascii = domainToASCII(value);
  } catch {
    return null;
  }
  if (ascii === '' || ascii.endsWith('.')) {
    return null;
  }

  const labels = ascii.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return null;
    }
    if (!LABEL.test(label)) {
      return null;
    }
  }

  // 纯数字点分形式是 IPv4 字面量，不能作为 Domain 属性。
  if (isIPv4Literal(ascii)) {
    return null;
  }
  return ascii;
}

/**
 * 规范化请求主机（URL 的 hostname）。
 * 请求主机允许是 IP 字面量与下划线主机名；仅做小写、去方括号与末尾点处理。
 */
export function canonicalizeRequestHost(hostname: string): string | null {
  let host = unwrapHost(hostname.trim().toLowerCase());
  if (host.length === 0) {
    return null;
  }
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  return host === '' ? null : host;
}

/** RFC 6265 §5.1.3 域匹配：相同域或为其后代域。 */
export function domainMatch(requestHost: string, cookieDomain: string): boolean {
  if (requestHost === cookieDomain) {
    return true;
  }
  return requestHost.endsWith(`.${cookieDomain}`);
}
