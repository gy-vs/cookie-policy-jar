/**
 * 最小公共后缀列表（Public Suffix List）实现。
 *
 * 完整 PSL 有数千条规则且需定期更新；作为内存库这里内置一份覆盖常见后缀、
 * 通配规则（*.ck）与例外规则（!www.ck）的小表，语义与
 * https://publicsuffix.org/ 的算法完全一致，便于表驱动测试。
 * 调用方可按需扩充此表。
 */

import { isIPLiteral } from './domain.js';

const RULES = [
  // 国际通用后缀
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'co',
  'dev',
  'app',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'co.jp',
  'ne.jp',
  'co.kr',
  'com.cn',
  'net.cn',
  'org.cn',
  'co.nz',
  // 通配规则：所有 *.ck 都是公共后缀
  '*.ck',
  // 例外：www.ck 本身是可注册域
  '!www.ck',
] as const;

const EXCEPTIONS = new Set<string>();
const WILDCARDS = new Set<string>();
const EXACT = new Set<string>();

for (const rule of RULES) {
  if (rule.startsWith('!')) {
    EXCEPTIONS.add(rule.slice(1));
  } else if (rule.startsWith('*.')) {
    WILDCARDS.add(rule.slice(2));
  } else {
    EXACT.add(rule);
  }
}

function labels(domain: string): string[] {
  return domain.split('.');
}

/**
 * 判断规范化后的域是否为公共后缀（IP 字面量返回 false）。
 */
export function isPublicSuffix(domain: string): boolean {
  if (isIPLiteral(domain)) {
    return false;
  }
  if (EXCEPTIONS.has(domain)) {
    return false;
  }
  if (EXACT.has(domain)) {
    return true;
  }
  const parts = labels(domain);
  for (let i = 0; i < parts.length; i += 1) {
    // 规则 "*.abc" 表示 abc 的任意一级子域（恰好多一个标签）是公共后缀。
    // 基后缀 candidate=parts[i..] 命中 WILDCARDS 时，公共后缀是
    // parts[i-1..]，即整个域恰好等于该后缀（左邻标签数为 1）。
    if (i === 1 && WILDCARDS.has(parts.slice(i).join('.'))) {
      return true;
    }
  }
  return false;
}

/**
 * 返回可注册域（eTLD+1）。无公共后缀或域本身不可再分时返回输入本身；
 * IP 字面量也返回输入本身。
 */
export function registrableDomain(domain: string): string | null {
  if (domain === '') {
    return null;
  }
  // IP 字面量的站点键就是其自身，不参与后缀切分。
  if (isIPLiteral(domain)) {
    return domain;
  }
  const parts = labels(domain);
  // 单标签（localhost 之类）与 IP 字面量：站点键就是主机本身。
  if (parts.length === 1) {
    return domain;
  }
  if (EXCEPTIONS.has(domain)) {
    return domain;
  }
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = parts.slice(i).join('.');
    if (EXCEPTIONS.has(candidate)) {
      return candidate;
    }
    if (EXACT.has(candidate)) {
      return i === 0 ? domain : parts.slice(i - 1).join('.');
    }
    // 通配规则 *.candidate：
    // i === 1 时整个域就是匹配的公共后缀（无左侧注册标签），返回自身；
    // i >= 2 时可注册域再多取一个左邻标签。
    if (i === 1 && WILDCARDS.has(candidate)) {
      return domain;
    }
    if (i >= 2 && WILDCARDS.has(candidate)) {
      return parts.slice(i - 2).join('.');
    }
  }
  // 未命中任何规则：最后两个标签视为可注册域。
  return parts.slice(-2).join('.');
}
