# 阶段 9 · admin-web 接云开发

> 上游：阶段 0–8（云函数 `api` 已覆盖 127 条路由 + 定时触发器 + 数据迁移）。
> 目标：**管理后台网页也能调用同一套云函数**，且随时可切回原 Express 后端。
> 状态：实现 + 断言已完成（32 项），真机部署待陛下在控制台配触发路径。

---

## 一、问题：网页没有 wx 环境

小程序走 `wx.cloud.callFunction`，event 就是我们自己的形状 `{ method, path, body, token }`，
**免备案**（不走「request 合法域名」白名单）。

admin-web 是浏览器页面，没有 wx 环境，只剩两条路：

| 方案 | 做法 | 备案 | 代价 |
|---|---|---|---|
| **A. HTTP 访问服务**（选它） | 云函数开 HTTP 触发，网页 POST 到 `https://<envId>-<数字>.ap-shanghai.app.tcloudbase.com/<触发路径>` | **不需要**（用官方默认域名） | 默认域名有**有效期**，到期控制台点「续期」 |
| B. `@cloudbase/js-sdk` | 网页直接 `app.callFunction()`，event 形状与小程序一致 → 云函数零改动 | **不需要** | 新增 npm 依赖；需开匿名登录 + 配 Web 安全域名；通道本身本地测不了 |

> ⚠️ **「要不要备案」的结论：两条都不需要。**
> 腾讯云给的官方默认域名（`<envId>-<数字>.ap-shanghai.app.tcloudbase.com` / `*.tcloudbaseapp.com`）已备案。
> 只有**绑自有域名**（如 `admin.xxx.edu.cn`）才需要备案 —— 那正是本次迁移要绕开的东西。

选 A 的理由：零新增依赖；适配层是**我们自己的代码**，能被回归网钉住（B 的通道正确性只能上真机验证）。

---

## 二、集成请求长什么样

云函数被 HTTP 触发时收到的不是我们的 event，而是：

```js
{
  path: '/api',                    // 控制台里配的「触发路径」
  httpMethod: 'POST',
  headers: { authorization: 'Bearer xxx', ... },
  queryStringParameters: {...},
  body: '<原始请求体字符串>',
  isBase64Encoded: false,
}
```

`api/httpBridge.js` 负责把它还原成 `{ method, path, body, token, query }`。
支持两种形态：

| 形态 | 请求 | 判据 | 什么时候用 |
|---|---|---|---|
| **信封** | `POST /api`，body = `{ method, path, body, token, query }` | 请求体里有 `path` | **admin-web 走这个** |
| RESTful | `GET /api/xxx?page=1` | 否则 | 兜底；需控制台开**路径透传** |

⚠️ 为什么主推信封：云接入默认**不开路径透传**时 `event.path` 恒等于触发路径（`/api`），
真实路由根本拿不到。信封把路由放进请求体，不依赖那项配置。

---

## 三、三个「不报错」的点

1. **适配必须放在 `index.js` 解构 event 之前**。
   放在后面（比如定时分支之后）时，`method/path/body/token` 早已从**旧 event** 解出来了 ——
   赋值 `event = {...}` 完全没有效果，而且**不报错**，只是 HTTP 请求永远命中 `/api` 这个不存在的路由。
2. **判据要收窄**：只认 `httpMethod || requestContext`。
   若写成「只要有 `path` 就算 HTTP」，小程序请求（同样有 `path`/`body`）会被**全部误判** ——
   小程序端直接全挂，而本地测试若只喂 HTTP 事件则一片绿。
   ⇒ `test-http-bridge.js` E 段专门钉了「小程序 callFunction 与定时触发照旧」。
3. **GET 参数要显式放进 `query`**。
   信封里漏了 `query` 的话，分页/筛选会**静默退回默认值** —— 页面表现为「一直是第一页」，不报错。
   ⇒ D08/D09 用「第 2 页只剩 1 条」证明参数真的到了 `ctx.query`。

---

## 四、admin-web 侧：门面模式（业务代码零改动）

`src/utils/http.js` 导出**同形状门面**：

- `VITE_REQUEST_MODE=direct`（默认）→ 直接导出原 axios 实例，行为**逐字不变**
- `VITE_REQUEST_MODE=cloud` → 导出 `{ get, post, put, patch, delete, request }`，
  内部统一 POST 信封到 `VITE_CLOUD_API_URL`，自己解包 `{ code, message, data }`

⇒ 全站 114 处 `http.get(...)` / `http.post(...)` **一行不用改**。

### xlsx 下载

源实现直接吐二进制流；云函数没有 HTTP 流，改成 `{ filename, base64, mime }` 契约。
cloud 模式下用 `atob` 还原成 `Blob` —— 调用方 `URL.createObjectURL(blob)` 的写法不变。

### 刻意没动的地方

- **登录页**（v4 分栏版，视觉唯一例外）未动。
- **401 处理未加 `body?.code === 40101`**：原后端鉴权失败统一返回 **HTTP 401**
  （`fail(res, code, msg, 401)`），现有 `status === 401` 分支已覆盖。
  顺手加 code 判断是**改既有行为**，不是等价迁移。

改前已备份 `admin-web/_backup/20260929-012034-src/`（69 个文件）。

---

## 五、断言

`cloud/scripts/test-http-bridge.js` —— **32 项 / 失败 0**，已纳入 `regression.js`（两轮都跑）。

| 段 | 内容 |
|---|---|
| A | 识别：什么算 HTTP 事件（含「有 path/body 但没 httpMethod → 不是」这条反向保护） |
| B | 信封模式：method/path/token、Authorization 头优先、base64 体、坏 JSON 兜底 |
| C | RESTful 兜底：GET 参数 / POST 请求体 |
| D | **穿透 `index.js` 真跑路由**：能登录、Authorization 里的 JWT 能过鉴权、没 token 照样 40101、query 生效、OPTIONS 放行 |
| E | ⭐ **反向保护**：小程序 callFunction 与定时触发照旧 |

---

## 六、陛下要做的（顺序不能乱）

1. 云开发控制台 → **HTTP 访问服务** → 给 `api` 云函数关联触发路径（建议 `/api`），记下默认域名
2. 部署云函数（产物已含 `httpBridge`，50 模块 / 394.9 KB）：
   `node cloud/scripts/deploy-cloud.js` 打印命令 → 手动跑 → 等 1~2 分钟
3. admin-web 根目录建 `.env.local`：
   ```
   VITE_REQUEST_MODE=cloud
   VITE_CLOUD_API_URL=https://<envId>-<数字>.ap-shanghai.app.tcloudbase.com/api
   ```
4. 重新构建 admin-web；若放到**静态网站托管**，把托管域名加进「Web 安全域名」

---

## 七、未决 / 风险

| # | 事项 | 处理 |
|---|---|---|
| 1 | 默认域名有**有效期** | 到期控制台点「续期」（5 分钟生效）；若嫌麻烦改走 B 方案 |
| 2 | 默认域名 QPS 上限 200 | 管理后台用量极小，不紧张 |
| 3 | `cadre/staff.avatar` 仍是 `/uploads/...` 相对路径 | 兼容期两套并存，云存储迁移不在本阶段 |
| 4 | HTTP 通道未做频率限制（原 `/admin/login` 有限流） | 与阶段 7 一样刻意未搬；管理后台非公网暴露，风险可接受 |
