/**
 * 公共类型定义。
 */

export type SameSite = 'Strict' | 'Lax' | 'None';

export type RejectReason =
  | 'invalid-syntax'
  | 'invalid-scheme'
  | 'invalid-domain'
  | 'domain-mismatch'
  | 'public-suffix'
  | 'secure-required'
  | 'partitioned-requires-secure'
  | 'invalid-partition';

/** Cookie 的只读快照，所有字段均为原始值的冻结副本。 */
export interface CookieView {
  readonly name: string;
  readonly value: string;
  /** 规范化后的域；host-only 时就是请求主机。 */
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly sameSite: SameSite;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly partitioned: boolean;
  /** 分区键（顶层站点键），未分区为 null。 */
  readonly partitionKey: string | null;
  /** 会话 Cookie（关闭即失效）为 null，否则为绝对毫秒时间戳。 */
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly creationIndex: number;
  readonly lastAccessTime: number;
}

/**
 * 请求上下文：描述本次请求相对其顶层页面的站点关系。
 *
 * - {@link RequestContext.site}：本请求源与顶层源的关系。
 *   缺省时由请求 URL 自身推导为 'same-site'。
 * - {@link RequestContext.topLevelSite}：顶层 URL，用于推导分区键。
 *   缺省时退化为请求 URL（即“第一方”）。
 */
export interface RequestContext {
  readonly method?: string;
  readonly site?: 'same-site' | 'cross-site';
  readonly topLevelSite?: string | URL;
  /** 是否为顶层导航（顶层框架的地址变更），默认 false。 */
  readonly topLevelNavigation?: boolean;
  /**
   * 非 HTTP API（如脚本可访问的 API）应置为 false，
   * 此时 HttpOnly Cookie 不会发送。默认 true（HTTP 请求）。
   */
  readonly httpApi?: boolean;
}

/** 入站 Set-Cookie 所在响应的上下文。 */
export interface StoreContext {
  /** 顶层站点 URL；携带 Partitioned 属性时必填，用于确定分区键。 */
  readonly topLevelSite?: string | URL;
  /** 注入当前时间，默认使用构造 CookieJar 时的时钟。 */
  readonly now?: number;
}

export interface StoredCookie {
  readonly ok: true;
  readonly name: string;
  /** 新记录为 true；替换或删除既有记录为 false。 */
  readonly created: boolean;
  /** 该 Cookie 最终是否存活；删除型属性（Max-Age<=0 或已过期）为 false。 */
  readonly alive: boolean;
  /** 若该记录被删除且此前存在，则为 true。 */
  readonly deleted: boolean;
  readonly cookie: CookieView;
}

export interface RejectedCookie {
  readonly ok: false;
  readonly reason: RejectReason;
  readonly detail: string;
}

export type StoreResult = StoredCookie | RejectedCookie;
