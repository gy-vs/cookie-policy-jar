/**
 * 内存 Cookie Jar。
 *
 * 设计要点：
 * - 时间由构造参数 now 或单次调用的 ctx.now 注入，便于测试。
 * - 身份键为 (name, domain, path, partitionKey)，hostOnly 不参与
 *   （RFC 6265 §5.3 的替换/删除规则不区分 host-only）。
 * - 诊断接口（entries / Symbol.iterator / size）只暴露深冻结快照。
 */
import type {
  CookieView,
  RejectReason,
  RejectedCookie,
  RequestContext,
  StoredCookie,
  StoreContext,
  StoreResult,
} from './types.js';
import { parseSetCookie } from './parser.js';
import {
  canonicalizeDomain,
  canonicalizeRequestHost,
  domainMatch,
  isIPLiteral,
} from './domain.js';
import { isPublicSuffix } from './public-suffix.js';
import {
  defaultPath,
  isSafeMethod,
  isSecureScheme,
  pathMatch,
  siteKey,
} from './path.js';

const MAX_DATE = 8_640_000_000_000_000;
const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

interface Entry {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieView['sameSite'];
  partitioned: boolean;
  partitionKey: string | null;
  expiresAt: number | null;
  createdAt: number;
  creationIndex: number;
  lastAccessTime: number;
}

export interface CookieJarOptions {
  /** 时钟注入；缺省使用 Date.now()。 */
  now?: () => number;
}

function toHttpUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    throw new TypeError(`Invalid URL: ${String(url)}`);
  }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol.toLowerCase())) {
    throw new TypeError(`Unsupported URL scheme for cookies: ${parsed.protocol}`);
  }
  if (parsed.hostname === '') {
    throw new TypeError('URL has no host');
  }
  return parsed;
}

function reject(reason: RejectReason, detail: string): RejectedCookie {
  return { ok: false, reason, detail };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key as string]);
    }
    Object.freeze(value);
  }
  return value;
}

export class CookieJar {
  #entries: Entry[] = [];
  readonly #now: () => number;
  #seq = 0;

  constructor(options: CookieJarOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** 当前存活记录数（按当前时钟清除过期项之后）。 */
  get size(): number {
    this.purgeExpired();
    return this.#entries.length;
  }

  /** 注入的时钟返回的当前时间。 */
  get currentTime(): number {
    return this.#now();
  }

  /**
   * 存入一条 Set-Cookie。
   * 拒绝不抛异常，返回 { ok: false, reason }。
   */
  setCookie(
    responseUrl: string | URL,
    setCookieHeader: string,
    context: StoreContext = {},
  ): StoreResult {
    const url = toHttpUrl(responseUrl);
    const now = context.now ?? this.#now();
    this.purgeExpired(now);

    const parsed = parseSetCookie(setCookieHeader);
    if (parsed === null) {
      return reject('invalid-syntax', 'Set-Cookie header failed RFC 6265 syntax');
    }

    const requestHost = canonicalizeRequestHost(url.hostname);
    if (requestHost === null) {
      return reject('invalid-scheme', 'response URL has no usable host');
    }

    // --- Domain 属性：规范化、域匹配、公共后缀越权检查 ---
    let domain = requestHost;
    let hostOnly = true;
    if (parsed.domain !== null) {
      const canon = canonicalizeDomain(parsed.domain);
      if (canon === null) {
        return reject('invalid-domain', `Domain="${parsed.domain}"`);
      }
      // IP 字面量主机只能保存为 host-only，不接受 Domain 属性。
      if (isIPLiteral(requestHost)) {
        return reject(
          'invalid-domain',
          `IP literal host ${requestHost} cannot use Domain attribute`,
        );
      }
      if (!domainMatch(requestHost, canon)) {
        return reject(
          'domain-mismatch',
          `host ${requestHost} cannot set Domain=${canon}`,
        );
      }
      if (isPublicSuffix(canon)) {
        return reject('public-suffix', `Domain=${canon} is a public suffix`);
      }
      domain = canon;
      hostOnly = false;
    }

    // --- Secure 与 Partitioned 的来源限制 ---
    const secureOrigin = isSecureScheme(url.protocol);
    if (parsed.secure && !secureOrigin) {
      return reject('secure-required', 'Secure cookie requires a secure origin');
    }
    if (parsed.partitioned && !parsed.secure) {
      return reject(
        'partitioned-requires-secure',
        'Partitioned cookies must carry the Secure attribute',
      );
    }

    let partitionKey: string | null = null;
    if (parsed.partitioned) {
      let topLevel: URL;
      try {
        topLevel =
          typeof context.topLevelSite === 'string' || context.topLevelSite instanceof URL
            ? new URL(context.topLevelSite)
            : (() => {
                throw new Error('missing topLevelSite');
              })();
      } catch {
        return reject(
          'invalid-partition',
          'Partitioned cookie requires a valid context.topLevelSite',
        );
      }
      if (!SUPPORTED_SCHEMES.has(topLevel.protocol.toLowerCase())) {
        return reject(
          'invalid-partition',
          `top-level site scheme ${topLevel.protocol} not supported`,
        );
      }
      partitionKey = siteKey(topLevel);
    }

    // --- Path：合法则使用属性值，否则取默认路径 ---
    let path: string;
    if (parsed.path !== null && parsed.path.startsWith('/')) {
      path = parsed.path;
    } else {
      path = defaultPath(url);
    }

    // --- 过期时间：Max-Age 优先于 Expires ---
    let expiresAt: number | null;
    if (parsed.maxAge !== null) {
      if (parsed.maxAge <= 0) {
        expiresAt = 0;
      } else {
        expiresAt = Math.min(now + parsed.maxAge * 1000, MAX_DATE);
      }
    } else {
      expiresAt = parsed.expires;
    }
    const isDeletion = expiresAt !== null && expiresAt <= now;

    // 身份键按需求定义为 (name, domain, path, partitionKey)；
    // host-only 不参与身份判定（host-only 与 Domain 同键记录视为同一条）。
    const existingIndex = this.#entries.findIndex(
      (entry) =>
        entry.name === parsed.name &&
        entry.domain === domain &&
        entry.path === path &&
        entry.partitionKey === partitionKey,
    );

    // --- 删除型：精确删除同一身份键的记录后结束 ---
    if (isDeletion) {
      let removedView: CookieView | null = null;
      if (existingIndex !== -1) {
        removedView = this.toView(this.#entries[existingIndex] as Entry);
        this.#entries.splice(existingIndex, 1);
      }
      const attempted = this.frozenView({
        name: parsed.name,
        value: parsed.value,
        domain,
        hostOnly,
        path,
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        sameSite: parsed.sameSite,
        partitioned: parsed.partitioned,
        partitionKey,
        expiresAt,
        createdAt: now,
        creationIndex: -1,
        lastAccessTime: now,
      });
      const stored: StoredCookie = {
        ok: true,
        name: parsed.name,
        created: false,
        alive: false,
        deleted: removedView !== null,
        cookie: removedView ?? attempted,
      };
      return stored;
    }

    if (existingIndex !== -1) {
      // 替换：保留创建时间与创建序号（RFC 6265 §5.3 第 12 步）。
      const existing = this.#entries[existingIndex] as Entry;
      const updated: Entry = {
        ...existing,
        value: parsed.value,
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        sameSite: parsed.sameSite,
        partitioned: parsed.partitioned,
        partitionKey,
        expiresAt,
        hostOnly,
        lastAccessTime: now,
      };
      this.#entries[existingIndex] = updated;
      return {
        ok: true,
        name: updated.name,
        created: false,
        alive: true,
        deleted: false,
        cookie: this.toView(updated),
      };
    }

    this.#seq += 1;
    const entry: Entry = {
      name: parsed.name,
      value: parsed.value,
      domain,
      hostOnly,
      path,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      partitioned: parsed.partitioned,
      partitionKey,
      expiresAt,
      createdAt: now,
      creationIndex: this.#seq,
      lastAccessTime: now,
    };
    this.#entries.push(entry);
    return {
      ok: true,
      name: entry.name,
      created: true,
      alive: true,
      deleted: false,
      cookie: this.toView(entry),
    };
  }

  /**
   * 批量存入同一响应的多条 Set-Cookie 头（响应中每个 Set-Cookie 是独立头，
   * 不能用逗号拼接）。返回与入参等长、同序的结果数组。
   */
  setCookies(
    responseUrl: string | URL,
    setCookieHeaders: readonly string[],
    context: StoreContext = {},
  ): StoreResult[] {
    return setCookieHeaders.map((header) => this.setCookie(responseUrl, header, context));
  }

  /** 返回将随请求发送的 Cookie 快照（已按发送顺序排序）。 */
  cookiesForUrl(
    requestUrl: string | URL,
    context: RequestContext = {},
  ): CookieView[] {
    const url = toHttpUrl(requestUrl);
    const now = this.#now();
    this.purgeExpired(now);

    const requestHost = canonicalizeRequestHost(url.hostname);
    if (requestHost === null) {
      return [];
    }
    const requestPath = url.pathname || '/';
    const secureRequest = isSecureScheme(url.protocol);
    const method = context.method ?? 'GET';
    const topLevelNavigation = context.topLevelNavigation ?? false;
    const httpApi = context.httpApi ?? true;

    const requestSite = siteKey(url);
    let topLevelUrl = url;
    if (context.topLevelSite !== undefined) {
      try {
        topLevelUrl = new URL(context.topLevelSite);
      } catch {
        return [];
      }
    }
    const topLevelKey = siteKey(topLevelUrl);
    const sameSiteRequest =
      context.site !== undefined
        ? context.site === 'same-site'
        : requestSite === topLevelKey;

    const matched: Entry[] = [];
    for (const entry of this.#entries) {
      // 域匹配
      const domainOK = entry.hostOnly
        ? entry.domain === requestHost
        : domainMatch(requestHost, entry.domain);
      if (!domainOK) {
        continue;
      }
      // 路径匹配
      if (!pathMatch(requestPath, entry.path)) {
        continue;
      }
      // Secure
      if (entry.secure && !secureRequest) {
        continue;
      }
      // HttpOnly 仅对 HTTP API 可见
      if (entry.httpOnly && !httpApi) {
        continue;
      }
      // 分区隔离
      if (entry.partitioned && entry.partitionKey !== topLevelKey) {
        continue;
      }
      // SameSite（分区 Cookie 按规范独立于 SameSite 判定）
      if (!entry.partitioned) {
        if (entry.sameSite === 'Strict' && !sameSiteRequest) {
          continue;
        }
        if (
          entry.sameSite === 'Lax' &&
          !sameSiteRequest &&
          !(topLevelNavigation && isSafeMethod(method))
        ) {
          continue;
        }
      }

      matched.push(entry);
      entry.lastAccessTime = now;
    }

    // 先按路径长度降序，再按创建序升序（稳定）。
    matched.sort((a, b) => {
      if (a.path.length !== b.path.length) {
        return b.path.length - a.path.length;
      }
      return a.creationIndex - b.creationIndex;
    });

    return matched.map((entry) => this.toView(entry));
  }

  /** 直接生成 Cookie 请求头；无匹配时返回空字符串。 */
  cookieHeader(requestUrl: string | URL, context: RequestContext = {}): string {
    return this.cookiesForUrl(requestUrl, context)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  /** 诊断：所有存活 Cookie 的深冻结快照，按创建序排列。 */
  entries(): readonly CookieView[] {
    this.purgeExpired();
    const views = this.#entries
      .slice()
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((entry) => this.toView(entry));
    return Object.freeze(views);
  }

  *[Symbol.iterator](): IterableIterator<CookieView> {
    for (const view of this.entries()) {
      yield view;
    }
  }

  /** 移除并返回已过期记录数。 */
  purgeExpired(now: number = this.#now()): number {
    let removed = 0;
    this.#entries = this.#entries.filter((entry) => {
      const alive = entry.expiresAt === null || entry.expiresAt > now;
      if (!alive) {
        removed += 1;
      }
      return alive;
    });
    return removed;
  }

  private toView(entry: Entry): CookieView {
    return this.frozenView({
      name: entry.name,
      value: entry.value,
      domain: entry.domain,
      hostOnly: entry.hostOnly,
      path: entry.path,
      sameSite: entry.sameSite,
      secure: entry.secure,
      httpOnly: entry.httpOnly,
      partitioned: entry.partitioned,
      partitionKey: entry.partitionKey,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
      creationIndex: entry.creationIndex,
      lastAccessTime: entry.lastAccessTime,
    });
  }

  private frozenView(view: CookieView): CookieView {
    return deepFreeze(view) as CookieView;
  }
}
