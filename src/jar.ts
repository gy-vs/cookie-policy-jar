/**
 * 内存 CookieJar：写入策略校验、覆盖 / 删除语义与发送筛选。
 *
 * 存储模型遵循 RFC 6265 第 5 节，并加入 SameSite（RFC 6265bis）、
 * CHIPS Partitioned、公共后缀越权拦截与 schemeful same-site。
 *
 * 内部状态不对外暴露可变引用：诊断接口返回深冻结的快照，篡改会抛错
 * 且不会影响后续行为。
 */
import {
  DEFAULT_SUFFIX_REGISTRY,
} from './suffixes.js';
import {
  domainMatch,
  isIpLiteral,
  isSameSite,
  normalizeDomain,
  requestHost,
  siteInfo,
  siteKey,
} from './domain.js';
import {
  defaultPath,
  parseCookieDate,
  parseMaxAge,
  parseSameSite,
  parseSetCookie,
  isPotentiallyTrustworthy,
} from './parse.js';
import type {
  CookieJarOptions,
  CookieView,
  CallTimeOptions,
  SetCookieContext,
  CookieRequestContext,
  SetCookieResult,
  StoredCookie,
  SuffixRegistry,
} from './types.js';

/** 允许的最大过期时刻，超出此值的 Expires/Max-Age 被钳制。 */
const MAX_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59);
const SESSION_EXPIRES = Infinity;

/**
 * 覆盖键：name + domain + path + partition key 完全相同才是同一条。
 * hostOnly 不进入键（同一 domain 下 host-only 与 Domain 属性 cookie 互斥）。
 */
function storageKey(
  name: string,
  domain: string,
  path: string,
  partitionKey: string | null,
): string {
  return JSON.stringify([name, domain, path, partitionKey]);
}

export class CookieJar {
  readonly #registry: SuffixRegistry;
  readonly #defaultNow: () => number;
  readonly #localhostSecure: boolean;
  #cookies = new Map<string, StoredCookie>();
  #creationCounter = 0;

  constructor(options: CookieJarOptions = {}) {
    this.#registry = options.suffixRegistry ?? DEFAULT_SUFFIX_REGISTRY;
    this.#defaultNow = options.now ?? (() => Date.now());
    this.#localhostSecure = options.treatLocalhostAsSecure ?? true;
  }

  #resolveNow(override: number | undefined): number {
    return override ?? this.#defaultNow();
  }

  #view(c: StoredCookie, now: number): CookieView {
    const view: CookieView = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      expiresAt: c.expiresAt,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      partitioned: c.partitioned,
      partitionKey: c.partitionKey,
      creationIndex: c.creationIndex,
      expired: c.expiresAt !== SESSION_EXPIRES && c.expiresAt <= now,
    };
    return Object.freeze(view);
  }

  // ------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------

  /**
   * 处理一条 Set-Cookie 响应头。
   * 校验顺序：语法 → Domain 合法性 → 域归属 / 公共后缀 → 安全来源 →
   *           Partitioned+Secure → 过期判定。
   */
  setCookie(
    ctx: SetCookieContext,
    header: string,
    options: CallTimeOptions = {},
  ): SetCookieResult {
    const now = this.#resolveNow(options.now);
    const parsed = parseSetCookie(header);
    if (parsed === null) return { status: 'rejected', reason: 'malformed-cookie' };

    const { name, value, attributes } = parsed;
    const host = requestHost(ctx.url);
    if (host === '') return { status: 'rejected', reason: 'invalid-domain' };

    // ---- Domain：非法值直接拒绝；合法但不归属则 host-only 回退 ----
    let domain = host;
    let hostOnly = true;
    const domainAttr = attributes.get('domain');
    if (domainAttr !== undefined && domainAttr !== '') {
      const normalized = normalizeDomain(domainAttr);
      if (normalized === null) {
        return { status: 'rejected', reason: 'invalid-domain' };
      }
      if (isIpLiteral(host) || !domainMatch(host, normalized)) {
        // RFC 6265：忽略 Domain 属性，按 host-only 存储
        domain = host;
        hostOnly = true;
      } else {
        domain = normalized;
        hostOnly = false;
      }
    }

    // ---- 公共后缀：Domain 不得把 cookie 设在公共后缀本身上 ----
    if (!hostOnly) {
      const info = siteInfo(domain, this.#registry);
      if (info.hostIsPublicSuffix) {
        return { status: 'rejected', reason: 'public-suffix' };
      }
    }

    // ---- 安全来源 ----
    const secureOrigin = isPotentiallyTrustworthy(
      ctx.url,
      this.#localhostSecure,
    );
    const secure = attributes.has('secure');
    if (secure && !secureOrigin) {
      return { status: 'rejected', reason: 'insecure-origin' };
    }

    const sameSite = parseSameSite(attributes.get('samesite'));
    if (sameSite === 'None' && !secure) {
      return { status: 'rejected', reason: 'insecure-origin' };
    }

    // ---- Partitioned（CHIPS）：必须来自安全来源且带 Secure ----
    const partitioned = attributes.has('partitioned');
    if (partitioned && !(secure && secureOrigin)) {
      return { status: 'rejected', reason: 'partitioned-requires-secure' };
    }
    const partitionKey = partitioned
      ? siteKey(ctx.topLevelUrl ?? ctx.url, this.#registry)
      : null;

    // ---- Path / HttpOnly ----
    const pathAttr = attributes.get('path');
    let path: string;
    if (pathAttr === undefined || pathAttr === '' || !pathAttr.startsWith('/')) {
      path = defaultPath(ctx.url);
    } else {
      path = pathAttr;
    }
    const httpOnly = attributes.has('httponly');

    // ---- 过期：Max-Age 优先于 Expires ----
    let expiresAt = SESSION_EXPIRES;
    const maxAgeRaw = parseMaxAge(attributes.get('max-age'));
    if (maxAgeRaw !== null) {
      if (maxAgeRaw <= 0) expiresAt = now;
      else expiresAt = Math.min(now + maxAgeRaw * 1000, MAX_DATE_MS);
    } else {
      const expiresAttr = attributes.get('expires');
      if (expiresAttr !== undefined) {
        const date = parseCookieDate(expiresAttr);
        if (date !== null) {
          const t = date.getTime();
          expiresAt = t < now ? now : Math.min(t, MAX_DATE_MS);
        }
      }
    }

    const key = storageKey(name, domain, path, partitionKey);
    const existing = this.#cookies.get(key);

    // ---- 删除型：精确命中 name/domain/path/partition key ----
    if (expiresAt <= now) {
      let removed = false;
      if (existing !== undefined) {
        this.#cookies.delete(key);
        removed = true;
      }
      const view: StoredCookie = {
        name,
        value,
        domain,
        hostOnly,
        path,
        expiresAt,
        secure,
        httpOnly,
        sameSite,
        partitioned,
        partitionKey,
        creationIndex: existing?.creationIndex ?? -1,
      };
      return {
        status: 'deleted',
        removed,
        cookie: removed ? this.#view(existing!, now) : this.#view(view, now),
      };
    }

    // ---- 插入或覆盖：覆盖保留创建序 ----
    const stored: StoredCookie = existing
      ? {
          ...existing,
          value,
          hostOnly,
          expiresAt,
          secure,
          httpOnly,
          sameSite,
          partitioned,
          // 覆盖时 domain/path/key 相同；属性变化也要持久化
        }
      : {
          name,
          value,
          domain,
          hostOnly,
          path,
          expiresAt,
          secure,
          httpOnly,
          sameSite,
          partitioned,
          partitionKey,
          creationIndex: this.#creationCounter++,
        };

    this.#cookies.set(key, stored);
    return {
      status: 'stored',
      replaced: existing !== undefined,
      cookie: this.#view(stored, now),
    };
  }

  // ------------------------------------------------------------------
  // 发送
  // ------------------------------------------------------------------

  /**
   * 生成后续请求的 Cookie 头（不含 "Cookie:" 前缀）。无匹配时返回 null。
   */
  getCookieHeader(
    ctx: CookieRequestContext,
    options: CallTimeOptions = {},
  ): string | null {
    const cookies = this.#select(ctx, options.now);
    if (cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * 返回本请求会发送的 Cookie 只读视图（已按 path 降序 + 创建序排序）。
   * 与 getCookieHeader 使用同一筛选管线，便于测试断言。
   */
  getCookiesForRequest(
    ctx: CookieRequestContext,
    options: CallTimeOptions = {},
  ): readonly CookieView[] {
    return this.#select(ctx, options.now).map((c) =>
      this.#view(c, this.#resolveNow(options.now)),
    );
  }

  #select(
    ctx: CookieRequestContext,
    nowOverride: number | undefined,
  ): StoredCookie[] {
    const now = this.#resolveNow(nowOverride);
    const host = requestHost(ctx.url);

    const topLevel = ctx.topLevelUrl;
    const crossSite =
      topLevel !== undefined && !isSameSite(topLevel, ctx.url, this.#registry);
    const isTopNav = ctx.isTopLevelNavigation ?? false;
    const method = (ctx.method ?? 'GET').toUpperCase();
    const safeMethod =
      method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'TRACE';
    const requestSiteKey =
      topLevel !== undefined ? siteKey(topLevel, this.#registry) : null;
    const secureRequest = isPotentiallyTrustworthy(
      ctx.url,
      this.#localhostSecure,
    );

    const matched: StoredCookie[] = [];

    for (const cookie of this.#cookies.values()) {
      // 过期清理（惰性）
      if (cookie.expiresAt !== SESSION_EXPIRES && cookie.expiresAt <= now) {
        continue;
      }
      // 域匹配
      if (cookie.hostOnly) {
        if (cookie.domain !== host) continue;
      } else if (!domainMatch(host, cookie.domain)) {
        continue;
      }
      // 路径匹配
      if (!this.#pathMatch(ctx.url.pathname, cookie.path)) continue;
      // Secure
      if (cookie.secure && !secureRequest) continue;

      // 分区 / 非分区互斥
      if (cookie.partitioned) {
        if (requestSiteKey === null) continue;
        if (cookie.partitionKey !== requestSiteKey) continue;
      } else if (crossSite) {
        // 非分区 cookie 在跨站请求中受 SameSite 约束
        if (cookie.sameSite === 'Strict') continue;
        if (cookie.sameSite === 'Lax') {
          if (!(isTopNav && safeMethod)) continue;
        }
        // None：已确保 Secure，放行
      }

      matched.push(cookie);
    }

    // 路径长度降序，创建序升序（稳定）
    matched.sort((a, b) => {
      if (a.path.length !== b.path.length) {
        return b.path.length - a.path.length;
      }
      return a.creationIndex - b.creationIndex;
    });
    return matched;
  }

  /** RFC 6265 5.1.4 path-match。 */
  #pathMatch(requestPath: string, cookiePath: string): boolean {
    const p = requestPath === '' ? '/' : requestPath;
    if (p === cookiePath) return true;
    if (!p.startsWith(cookiePath)) return false;
    if (cookiePath.endsWith('/')) return true;
    return p.charAt(cookiePath.length) === '/';
  }

  // ------------------------------------------------------------------
  // 诊断
  // ------------------------------------------------------------------

  /** 当前条目数（过期条目惰性剔除后）。 */
  get size(): number {
    const now = this.#defaultNow();
    let n = 0;
    for (const c of this.#cookies.values()) {
      if (c.expiresAt === SESSION_EXPIRES || c.expiresAt > now) n++;
    }
    return n;
  }

  /**
   * 内部状态的不可篡改快照。返回的数组与每个对象均被 Object.freeze；
   * 按 creationIndex 排序。注入 now 可固定 expired 标记。
   */
  snapshot(options: CallTimeOptions = {}): readonly CookieView[] {
    const now = this.#resolveNow(options.now);
    const views = [...this.#cookies.values()]
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((c) => this.#view(c, now));
    return Object.freeze(views);
  }

  /** 迭代器协议；遍历的是冻结快照视图，不暴露内部存储。 */
  [Symbol.iterator](): Iterator<CookieView> {
    return this.snapshot()[Symbol.iterator]();
  }

  /** 按覆盖键精确查询（诊断用途）。 */
  getCookie(
    name: string,
    domain: string,
    path: string,
    partitionKey: string | null = null,
    options: CallTimeOptions = {},
  ): CookieView | null {
    const now = this.#resolveNow(options.now);
    const c = this.#cookies.get(storageKey(name, domain, path, partitionKey));
    if (c === undefined) return null;
    return this.#view(c, now);
  }
}
