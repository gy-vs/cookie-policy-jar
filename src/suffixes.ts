/**
 * 内置的最小公共后缀注册表。
 *
 * 服务端库不内置完整 PSL（体积大且更新频繁）。这里只收录跨站测试最常
 * 涉及的多标签后缀与代表性条目；生产使用时由调用者注入完整快照。
 */
import type { SuffixRegistry } from './types.js';

const EXACT = [
  'com',
  'net',
  'org',
  'io',
  'co',
  'dev',
  'app',
  'edu',
  'gov',
  'co.jp',
  'co.uk',
  'com.cn',
  'com.au',
  'github.io',
  'pvt.k12.ma.us',
];

const WILDCARD = [
  // *.ck 整个是公共后缀（如 www.ck、abc.ck）
  'ck',
  // 规则：*.bd
  'bd',
  // 规则：*.mm
  'mm',
];

export const DEFAULT_SUFFIX_REGISTRY: SuffixRegistry = Object.freeze({
  exact: new Set(EXACT),
  wildcard: new Set(WILDCARD),
});
