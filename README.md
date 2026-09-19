# cookie-policy-jar

服务端可用的**内存** Cookie Jar：输入响应 URL、`Set-Cookie` 字符串和请求上下文，
输出后续请求的 `Cookie` 头。纯 TypeScript / Node.js 20，零运行时依赖
（URL 使用标准 WHATWG `URL`，不使用任何 Cookie/URL 解析库）。

## 适用与不适用

- ✅ HTTP 客户端 / 代理 / 爬虫等服务端场景的 Cookie 存储与回放
- ✅ RFC 6265 的存储模型（host-only、Domain、Path、Expires/Max-Age、Secure、HttpOnly）
- ✅ SameSite（Strict / Lax / None）与分区 Cookie（CHIPS `Partitioned`）
- ❌ 浏览器适配、JS `document.cookie` 语义
- ❌ 持久化（进程退出即消失）
- ❌ 命令行 / Web 页面

## 快速开始

```ts
import { CookieJar } from './src/index.js';

// 时间可由调用者注入（默认 Date.now）
const jar = new CookieJar({ now: () => Date.now() });

// 1) 存储响应里的 Set-Cookie
jar.setCookie('https://www.example.com/app/index', 'sid=abc; Path=/; HttpOnly; Secure');

// 2) 批量存储同一响应的多个 Set-Cookie（不要用逗号拼接）
jar.setCookies('https://example.com/', ['a=1', 'b=2; Max-Age=60']);

// 3) 生成后续请求头
jar.cookieHeader('https://www.example.com/app/home');
// => 'sid=abc; a=1; b=2'

// 跨站嵌入请求：显式给站点关系、顶层站点、方法与导航信息
jar.cookieHeader('https://api.example.com/data', {
  method: 'POST',
  site: 'cross-site',                 // 'same-site' | 'cross-site'
  topLevelSite: 'https://other.test', // 推导分区键
  topLevelNavigation: false,
  httpApi: true,                      // false 时 HttpOnly 不发送
});
```

非法或越权的 `Set-Cookie` 不会抛异常，返回带原因的拒绝结果：

```ts
const r = jar.setCookie('http://example.com/', 'a=1; Secure');
// { ok: false, reason: 'secure-required', detail: '...' }
```

拒绝原因：`invalid-syntax` / `invalid-scheme` / `invalid-domain` /
`domain-mismatch` / `public-suffix` / `secure-required` /
`partitioned-requires-secure` / `invalid-partition`。

## 规则要点

### 域名规范化

- 全部 ASCII 小写并去末尾根点（`EXAMPLE.COM.` 与 `example.com` 等价）
- IDN 经 `node:url` 的 UTS #46 转 A 标签（`例え.jp` → `xn--r8jz45g.jp`）
- LDH 逐标签校验；IP 字面量不允许出现在 `Domain` 属性中
- `Domain` 必须是请求主机本身或其父域，且不能是公共后缀（内置精简 PSL，
  含通配 `*.ck` 与例外 `!www.ck`，可在 `src/public-suffix.ts` 扩充）

### 存储

- 无 `Domain` → host-only（仅同主机发送）；有 `Domain` → 子域可见
- 默认 `Path` 取响应 URL 的目录（RFC 6265 §5.1.4）
- 过期：`Max-Age` 优先于 `Expires`；`Max-Age<=0` 或过去时间为删除型
- 删除型按 `(name, domain, path, partitionKey)` 精确删除，不波及其他路径/分区
- 更新既有记录时保留原创建时间与创建序号
- `Secure` 只接受安全来源（https/wss）；`Partitioned` 必须同时带 `Secure`，
  且必须在响应上下文中提供 `topLevelSite` 以确定分区键
- SameSite 缺省按 `Lax`

### 发送筛选（顺序短路）

1. 域匹配（host-only 要求完全相等）
2. 路径匹配（RFC §5.1.4）
3. `Secure` Cookie 仅在安全请求上发送
4. `HttpOnly` 仅在 HTTP API 上发送（`httpApi: false` 时隐藏）
5. 分区 Cookie 的分区键必须等于顶层站点键（schemeful）
6. SameSite（分区 Cookie 按 CHIPS 独立于此判定）：
   - `Strict`：仅同站
   - `Lax`：同站，或跨站顶层导航 + 安全方法（GET/HEAD/OPTIONS/TRACE）
   - `None`：不限制（浏览器要求带 Secure，存储时如实记录）

输出顺序：先按 path 长度降序，再按创建序号升序（稳定）。

### 站点键

`scheme://可注册域`（schemeful site，http/https 不同站）；IP 字面量与
单标签主机（`localhost`）使用主机本身。

## 诊断接口

诊断只暴露**深冻结的只读快照**，外部无法篡改内部数组或记录：

```ts
jar.size;               // 存活数量（先按当前时钟清理过期项）
for (const c of jar) {} // 迭代器，等价于 entries()
const all = jar.entries();   // readonly CookieView[]，深冻结
jar.purgeExpired();          // 主动清理，返回被清理条数
```

快照是值拷贝，之后的写入/删除/时钟推进不会改变之前拿到的快照。

## 时间注入

```ts
let now = 0;
const jar = new CookieJar({ now: () => now });
jar.setCookie('https://e.com/', 'a=1; Max-Age=10');
now = 11_000;
jar.cookieHeader('https://e.com/'); // '' —— 已过期
```

单次存储也可用 `jar.setCookie(url, header, { now })` 覆盖。

## 测试

表驱动测试覆盖日期、域名、路径、站点边界、存储拒绝、删除、SameSite、
分区、排序与诊断：

```bash
npm test        # tsc 编译后用 node --test 运行 dist/tests
npm run typecheck
```

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/jar.ts` | `CookieJar`：存储/更新/删除、发送筛选、排序、诊断快照 |
| `src/parser.ts` | `Set-Cookie` 解析（属性收集，不做来源校验） |
| `src/date.ts` | RFC 6265 §5.1.1 cookie 日期解析 |
| `src/domain.ts` | 域名/主机规范化、IP 识别、域匹配 |
| `src/public-suffix.ts` | 精简 PSL（精确/通配/例外规则）与可注册域 |
| `src/path.ts` | 默认路径、路径匹配、schemeful site 键、安全方法 |
| `src/types.ts` | 公共类型 |
