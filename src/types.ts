/**
 * 公共类型定义。
 *
 * 时间一律由调用者注入（毫秒 Unix 时间戳），库内部不直接读取系统时钟，
 * 便于在表驱动测试中固定时间。
 */

/** SameSite 属性三种取值。未携带或无法识别时按 Lax 处理。 */
export type SameSiteMode = 'Strict' | 'Lax' | 'None';

/**
 * 存储一条 Cookie 的完整记录。
 *
 * domain 已经过 ASCII 小写与末尾点规范化；hostOnly 为 true 时 domain 必须
 * 与来源主机完全一致，发送时不允许子域命中。
 *
 * partitionKey 为 null 表示未分区；分区记录的值为顶层站点键（schema+主机名）。
 * creationIndex 单调递增，即使记录被更新也保持不变，用于稳定排序。
 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  /** 过期时刻（毫秒）；Infinity 表示会话 Cookie。 */
  expiresAt: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  partitioned: boolean;
  partitionKey: string | null;
  creationIndex: number;
}

/** 诊断快照中对外可见的只读记录。 */
export type CookieView = Readonly<{
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expiresAt: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  partitioned: boolean;
  partitionKey: string | null;
  creationIndex: number;
  /** 注入时刻下该记录是否已过期（会话 Cookie 恒为 false）。 */
  expired: boolean;
}>;

/**
 * 写入 Set-Cookie 时的响应上下文。
 *
 * url 为携带该 Set-Cookie 的响应 URL；topLevelUrl 为当前页面顶层 URL，
 * 仅在写入分区 Cookie 时用于推导分区键，缺省退化为响应 URL。
 */
export interface SetCookieContext {
  url: URL;
  topLevelUrl?: URL;
}

/**
 * 生成 Cookie 请求头时的请求上下文。
 *
 * topLevelUrl 缺省时视为同站（非跨站上下文），SameSite 只按 secure 等条件
 * 过滤；isTopLevelNavigation 表示本次请求是顶层框架导航。
 * method 缺省为 GET。
 */
export interface CookieRequestContext {
  url: URL;
  topLevelUrl?: URL;
  isTopLevelNavigation?: boolean;
  method?: string;
}

/** setCookie 的拒绝原因，可枚举、可断言。 */
export type RejectReason =
  | 'malformed-cookie'
  | 'invalid-domain'
  | 'domain-overreach'
  | 'public-suffix'
  | 'insecure-origin'
  | 'partitioned-requires-secure';

/** setCookie 的结构化结果。 */
export type SetCookieResult =
  | { status: 'stored'; replaced: boolean; cookie: CookieView }
  | { status: 'deleted'; removed: boolean; cookie: CookieView | null }
  | { status: 'rejected'; reason: RejectReason };

/** 公共后缀注册表：exact 为完全匹配项，wildcard 为 "*.<suffix>" 的后缀主体。 */
export interface SuffixRegistry {
  exact: ReadonlySet<string>;
  wildcard: ReadonlySet<string>;
}

/** CookieJar 构造选项。 */
export interface CookieJarOptions {
  /**
   * 注入当前时间（毫秒 Unix 时间戳）。缺省在每次调用时使用 Date.now()。
   * 也可以在单次 setCookie / getCookieHeader 调用时覆盖。
   */
  now?: () => number;
  /**
   * 公共后缀注册表，缺省使用内置最小集合。
   * 调用者可注入完整 PSL 快照（如从 publicsuffix-publicsuffix-list 生成）。
   */
  suffixRegistry?: SuffixRegistry;
  /**
   * 是否将 http://localhost 及回环地址视为安全来源。默认 true。
   */
  treatLocalhostAsSecure?: boolean;
}

/** 单次调用级别的覆盖选项。 */
export interface CallTimeOptions {
  now?: number;
}
