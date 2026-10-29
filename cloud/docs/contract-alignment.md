# 前后端接口对齐怎么做

> 2026-10-27 落地。适用于 `cloud/`（云函数网关）+ `miniprogram/`（小程序端）这一对。

---

## 0. 一句话

**把「接口长什么样」写成一份可执行的声明（契约），然后用两个脚本分别从静态和运行时去对撞它。**

- 静态：前端调的**路径**在不在路由表里 → 抓 404
- 运行时：后端真实返回的**字段**符不符合契约 → 抓字段漂移

---

## 1. 为什么需要这套东西

这个项目的前后端是**两套独立代码，中间没有任何编译期约束**：

```
前端  miniprogram/**/*.js        adminRequest('/partner/slots', 'PUT', {...})
                                    ↓  字符串，拼错了没人管
后端  cloud/api/router.js        ['PUT /partner/slots/draft', 'partner.slots.saveDraft']
                                    ↓  字符串，改错了也没人管
```

两类错误，严重程度完全不同：

| 错误 | 表现 | 什么时候发现 |
|---|---|---|
| **路径写错 / METHOD 不对** | `40401 接口不存在` | 用户点到那一页时，一眼可见 |
| **字段漂移** | 界面空了一块，**不报错** | 可能永远发现不了，直到用户来问 |

字段漂移的三种典型形态，都是静默的：

1. **改名**：后端把 `dutyRoles` 改成 `roles` → 前端读 `undefined` → `wx:for` 渲染空数组
2. **`undefined` 被吞**：`JSON.stringify({a: undefined})` → `{}`。前端连字段名都看不到，
   `v === null` 判断永远不进（`cloud/lib/db.js` 头注里记过一次）
3. **类型变了**：后端返回 `Date` 对象 → 过 JSON 变成 ISO 字符串。
   前端 `new Date(v)` 还能转，`v.getTime()` 直接崩

---

## 2. 三层防线

### 第一层：契约文件（单一事实源）

`cloud/contracts/<模块>.js`，一个接口一条：

```js
'GET /partner/me': {
  method: 'GET',
  path: '/partner/me',
  auth: 'admin',                    // public | user | admin | super
  desc: '当前伙伴的身份、资格与能力位',
  req: {},                          // GET 无 body
  resp: {
    id: 'number',
    dutyRoles: 'string[]',
    abilities: { canEditSlots: 'boolean' },
  },
},
```

形状写法：

| 写法 | 含义 |
|---|---|
| `'number'` `'string'` `'boolean'` | 基本类型，**必须存在且非 null** |
| `'string[]'` `'number[]'` | 基本类型数组 |
| `'string|null'` | 可空 |
| `'string?'` | 可选（字段可以不存在，只用于 `req`） |
| `'any'` | 不校验（时间戳、任意对象） |
| `{ a: 'number' }` | 对象，**字段必须齐全**（多出来的不管） |
| `[{ a: 'number' }]` | 数组，**单元素数组 = 元素模板** |

**核心约定：字段必须存在，值可以是 `null`。** 后端 handler 用 `pick()` 投影时缺字段补 `null`，
就是为了满足这条 —— `undefined` 会被 `JSON.stringify` 整个丢掉。

### 第二层：静态校验（抓 404）

```bash
npm run check:contract
```

扫 `miniprogram/**/*.js` 里所有 `request('/xxx', 'METHOD', ...)` 和 `adminRequest(...)`，
和 `router.js` 的 `RAW_ROUTES` 对撞：

- **E1** 前端调了路由表里没有的接口 → 必然 404
- **E2** 路径存在但 METHOD 不对（比 E1 隐蔽，返回的是 40401 不是 405）
- **E3** 契约声明了但路由表里没有
- **E4** 契约声明了但前端没调（提示，不算错 —— 可能只给 admin-web 用）

动态拼接的路径（`'/user/recruitment/' + path`、模板字符串）静态分析看不到运行时值，
**跳过并单独列出**，避免假警报。

### 第三层：运行时校验（抓字段漂移）

```bash
npm run verify:contract
```

用 `cloud/scripts/harness.js` 的内存假库 + **真 handler**（不是 mock），
按一条真实业务流依次调用，每个响应立刻用契约校验：

- 字段缺失（含嵌套，如 `data.list[0].dutyRoles`）
- 类型不符（期望 `number` 实际 `string`）
- null 语义不对（声明非空却返回 null）

**有效性自证**：把契约里 `dutyRoles` 故意改成 `roles`，跑一遍立刻报 4 处 FAIL；
还原后全绿。这个手法可以随时用来确认工具没失效。

---

## 3. 新增一个接口的标准动作

```
① 后端  cloud/api/handlers/<模块>/<文件>.js     写 handler，返回**扁平、字段齐全**的对象
② 路由  cloud/api/router.js                     注册 'METHOD /path' → '模块.方法'
③ 登记  cloud/api/handlers/index.js             REGISTRY 加一行（**字面量 require，不能拼接**）
④ 契约  cloud/contracts/<模块>.js               写 req / resp 形状
⑤ 校验  verify-contract.js 的流程里加一行调用   （不加就不会被校验到）
⑥ 前端  miniprogram/...                         调 adminRequest / request
⑦ 跑     npm run check:all                      四关全绿才算完成
⑧ 打包   npm run cloud:sync                     ⚠️ 不 sync 部署的是旧产物
```

**最容易漏的是 ③ 和 ⑤**：

- ③ 漏了 → 运行时报 `模块未登记：partner.xxx`，但本地 harness 测试可能因为缓存看不出
- ⑤ 漏了 → 该接口永远不会被契约校验，等于没有防线

---

## 4. 已踩过的坑（写在这免得再踩）

| 坑 | 现象 | 修法 |
|---|---|---|
| **DELETE 的参数拿不到** | `index.js` 只对 GET 做 `body → query` 收敛，DELETE 的参数在 body 里但 handler 读 `ctx.query` → 静默用了默认值 | handler 里 `Object.assign({}, ctx.query, ctx.body)` |
| **路径参数没替换** | 校验器直接拿 `/partner/people/:id` 去请求，`:id` 被当字面量 → `Number(':id')` = NaN | 校验器里 `path.replace(/:(\w+)/g, ...)` |
| **动态拼接误报** | `'/user/recruitment/' + path` 被当成完整路径 → 假 E1 | 匹配到字符串后看紧跟的是不是 `+` |
| **空草稿占版本号** | 测试断言版本不递增 | 不是 bug：版本号在**草稿创建时**分配，空草稿也占号 |
| **打包产物过期** | 源码测试全绿、产物测试红 | 改完 `cloud/` 必须 `npm run cloud:sync`；测试要**两边都跑** |

---

## 5. 命令速查

```bash
npm run check:contract    # 静态：路径 / METHOD
npm run verify:contract   # 运行时：字段 / 类型 / null
npm run test:partner      # 伙伴端业务断言（134 项）
npm run check:all         # 四关一起跑
npm run cloud:sync        # 打包云函数单文件（改完 cloud/ 必做）
```

`check:all` 的输出就是**上线前的放行条件**，任何一关红都不该部署。

---

## 6. 还没做的（知道缺口在哪）

- **请求体字段没校验**：cloud 模式下 body 是普通对象，静态分析拿不到真实形状。
  目前只校验响应。要补的话，得在 harness 里按契约的 `req` 反向构造并断言「少传必填项应该报错」。
- **枚举值没校验**：契约里 `roleKey: 'string'` 只保证是字符串，
  不保证是 `'super' | 'manager'` 之一。要补可以加 `'enum:super|manager'` 语法。
- **契约与前端调用点的字段级关联没做**：现在只能证明「后端返回的字段齐全」，
  不能证明「前端读的字段后端真的给了」。后者需要 AST 分析前端 `data.xxx` 的访问路径。
