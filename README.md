# cookie-policy-jar

服务端可用的内存 Cookie Jar。输入响应 URL、`Set-Cookie` 字符串和请求上下文，
输出后续请求的 `Cookie` 头。

- 仅内存实现：无浏览器适配、无持久化、无 CLI、无页面
- 时间由调用者注入（构造时或单次调用时），测试可完全确定
- 不依赖任何 Cookie/URL 解析库（标准 WHATWG `URL` 除外）
- TypeScript + Node.js 20，ESM

## 策略覆盖

存储（RFC 6265 §5.2/§5.3 + 扩展）：

- host-only / `Domain`（非法 Domain 拒绝；合法但不归属则回退 host-only）
- 域名规范化：ASCII 小写、去除唯一末尾根点、LDH 标签校验
- 默认 Path（§5.1.4）与显式 Path
- `Max-Age` 优先于 `Expires`；Cookie 日期按 §5.1.1 解析
- `Secure` / `HttpOnly` / `SameSite`（缺省按 **Lax**）/ `Partitioned`（CHIPS）
- 公共后缀越权拦截（可注入 PSL 快照，内置最小注册表，支持 exact / wildcard）
- 安全来源校验；`SameSite=None` 与 `Partitioned` 均要求 `Secure`
- 删除型 `Set-Cookie` 精确匹配 name + domain + path + partition key
- 覆盖更新保留原始创建序（creationIndex 不变）

发送（§5.4 + SameSite/CHIPS）：

- domain-match（host-only 仅精确主机）、path-match（§5.1.4）
- Secure（非安全来源不发送）
- schemeful same-site（含 ws/wss → http/https 映射）
- SameSite 矩阵：Strict 跨站一律不发；Lax 仅跨站顶层安全方法导航；None 要求 Secure
- 分区 Cookie 仅在相同顶层站点键下发送；与非分区同名记录互不相干
- 排序：path 长度降序，再按创建序稳定排序（同名不同路径会全部输出）

## 快速开始

```ts
import { CookieJar } from 'cookie-policy-jar';

const jar = new CookieJar({ now: () => Date.now() });

// 1) 处理响应
jar.setCookie(
  { url: new URL('https://example.com/api') },
  'sid=abc; Path=/; HttpOnly; SameSite=Lax',
);

// 2) 生成请求头
const header = jar.getCookieHeader({
  url: new URL('https://example.com/profile'),
  topLevelUrl: new URL('https://example.com/'),
  method: 'GET',
});
// => "sid=abc"（无匹配时为 null）
```

跨站分区 Cookie：

```ts
jar.setCookie(
  {
    url: new URL('https://shop.example/frame'),
    topLevelUrl: new URL('https://news.test/'),
  },
  'cart=1; Partitioned; Secure; SameSite=None; Path=/',
);

jar.getCookieHeader({
  url: new URL('https://shop.example/frame'),
  topLevelUrl: new URL('https://www.news.test/'), // 同站点（eTLD+1 相同）
}); // => "cart=1"
```

注入完整公共后缀表：

```ts
const jar = new CookieJar({
  suffixRegistry: {
    exact: new Set([/* PSL 中的非通配规则 */]),
    wildcard: new Set([/* "*.<body>" 规则的 body 部分，如 "ck" */]),
  },
});
```

## 结构化结果

`setCookie` 返回可判别联合，拒绝原因可枚举：

| status    | 说明 |
| ---------- | ---- |
| `stored`  | 新插入或覆盖（`replaced` 区分） |
| `deleted` | 删除型 Set-Cookie（`removed` 表示是否命中） |
| `rejected`| `malformed-cookie` / `invalid-domain` / `domain-overreach`* / `public-suffix` / `insecure-origin` / `partitioned-requires-secure` |

\* 不归属的合法 Domain 按 RFC 回退 host-only，因此 `domain-overreach` 保留给调用方扩展场景。

## 诊断接口（可枚举、不可篡改）

```ts
jar.snapshot({ now: 123456 });        // 冻结的只读视图数组，按创建序
jar.size;                             // 未过期条目数
jar.getCookie('a', 'example.com', '/'); // 按覆盖键精确查询
for (const c of jar) { /* c 被 Object.freeze */ }
```

快照数组与每条记录均被 `Object.freeze`，篡改抛 `TypeError`，内部状态不外泄。

## 测试

```bash
npm test       # node:test + 表驱动（日期 / 域名 / 路径 / 站点边界）
npm run build
```
