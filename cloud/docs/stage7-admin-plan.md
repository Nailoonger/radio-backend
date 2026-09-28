# 阶段 7 · 管理端接口移植方案与验收（93/93 完成）

> 状态：**已完成**（2026-09-29）。本文记录「做了什么 / 有意偏离什么 / 还剩什么要陛下定夺」。
> 权威口径在 `cloud/README.md` 与三条守门脚本里；本文只写**决策与待办**。

---

## 一、范围

| | 数量 |
|---|---|
| 管理端路由 | **93 条**（`ADMIN_ROUTES`） |
| 其中超管专属 | 56 条路由 |
| 其中普管可调 | 37 条路由 |
| 去重后的 handlerKey | **91 个**（`capacity` / `sweepQueue` 各一 key 两路由） |
| handler 模块 | 13 个（+ 2 个下划线公共件） |

主要来源：`src/controllers/admin/*.js`（`submitController` 单文件 1083 行）。
发布时**原样保留** `src/`、`admin-web/`、Docker 链路一行不动（随时可切回 `direct`）。

---

## 二、云化改动清单（提交路径的「同款意图、不同写法」）

`handlers/admin/submit.js` 文件头逐条记录了 10 处改动，这里只列**判断依据**：

| # | 源写法 | 云端写法 | 为什么不能照抄 |
|---|---|---|---|
| ① | 路由挂 `adminAuth + requireSuperAdmin` | handler 第一行 `asAdmin(ctx)` / `asSuper(ctx)` | 云函数没有中间件层；漏写 = 没登录也能调，**不报错** |
| ② | `Op.like '%kw%'` | 全量拉 + JS 子串，**大小写不敏感** | 云库无 LIKE；写成 `includes()` 会静默变成区分大小写（MySQL 默认 `general_ci`） |
| ③ | `order: [[createTime,'ASC'],[id,'ASC']]` | `sortRows` 多键，比较 Date 按 `getTime()` | 文档是独立 Date 实例，`===` 恒 false → 比较器自相矛盾 → 排序退化成插入顺序 |
| ④ | `attributes: [...]` | `pick(row, fields)`，缺字段补 `null` | 云库无字段投影；`undefined` 会被 `JSON.stringify` **整个丢掉** |
| ⑤ | `sequelize.transaction` | 顺序执行 + 分批（每批 100） | 无跨文档事务；好在这些写本身幂等，重跑即可收敛 |
| ⑥ | 云端 `GROUP BY` / `MIN` `MAX` | JS 聚合 / 两次「排序 + limit:1」 | 云库不认聚合管道（自研 harness 也不支持） |
| ⑦ | `reload()` | `reread(row)` 回读一次 | 无 ORM 实例 |
| ⑧ | `req.admin` | `ctx.admin` = JWT payload | 同义 |
| ⑨ | `affectedRows === 0` 静默返回 | **显式 `conflict: true` 回读**（有意小改进） | 并发冲突时前端该刷新，不该只是「没变化」 |
| ⑩ | `res.json({code:0, message:'...'})` | `message: 'ok'` | 前端 `request.js` 在 `code===0` 时直接 `return data`，**成功消息被丢弃** → 零可见差异 |

---

## 三、有意偏离（已判定，无需再议）

1. **修了 3 个真权限 bug**：`admin/cadre` / `admin/staff` / `admin/showcase` 的 handler
   写成 `asAdmin`，而 `src/routes/admin.js` 挂的是 `requireSuperAdmin` → **普管本不该能写却写得动**。
   已改为 `asSuper`，并加入**双向显式声明**的权限矩阵断言防回归。
2. **并发冲突显式回读**（上表 ⑨）。
3. **`formatTime` / `stamp` 改北京时间**：源实现用容器本地时间（本项目容器是 UTC），
   导出的「最近登录时间」比实际早 8 小时 → 属缺陷，按全项目口径改用 `lib/bjTime`。
4. **二进制契约改为 JSON + base64**（下节详述）。
5. **未搬 `loginLimiter` / `submitLimiter` / `messageLimiter`**：Express 内存限流在云函数
   多实例下天然失效，留着只会给人「有防护」的错觉。防刷改由「时间窗口 + 唯一键」业务规则兜
   （`40901` 一分钟内重提等），已有断言覆盖。
6. **未搬 `uploadController`**：全项目没有任何路由引用它。

---

## 四、⚠️ 二进制文件的传输契约（前端阶段 9 必须配合）

云函数 `callFunction` **只走 JSON**：没有 multipart 上传，也没有二进制响应体。

| 方向 | 原 HTTP | 云函数 |
|---|---|---|
| 上传名册 | `multipart/form-data` + `file` | `{ filename, fileBase64 }` |
| 下载模板 / 导出 | `res.send(buffer)` + `Content-Disposition` | `{ filename, mime, base64 }` |

前端需要：
- 上传：`FileReader.readAsDataURL()` 或 `arrayBuffer` → base64（`data:...;base64,` 前缀会被剥掉）
- 下载：`atob(base64)` → `Uint8Array` → `Blob` → `URL.createObjectURL` → `<a download>`

**大小上限**：云函数单次请求/响应体约 **1 MB**；xlsx 转 base64 再 +33%。
→ 几千行的名册够用；**超大名册需要改走云存储**（先 `uploadFile`，再把 `fileID` 传给云函数）。
`handlers/admin/student.js` 已把这条边界写在文件头。

---

## 五、待陛下定夺（三件）

### ① `stats.overview` 的 `approved` 口径

- 现状：**逐字照抄源实现**，数的是 `status: 1`。
- 问题：协议改版后 `status` 变成**派生镜像** —— `0 待审 / 1 已排期 / 2 已驳回 / 5 已播放 /
  6 已通过·待排期 / 7 已取消`。`1` 现在表示「已排期」，不是「已通过」。
- 影响：「概览页的『已通过』数字偏小」—— 审核通过但还没排期的（`6`）不计入。
- 两个选项：
  - **A. 保持 `status: 1`**（现状，与源后端一致，零风险）
  - **B. 改成 `status ∈ {1, 5, 6}`**（语义修正，但会改变概览数字）
- 我的建议：**B**，并把卡片文案从「已通过」改为「已通过 · 已排期」。但这属于业务语义，等您点头。

### ② `previewSchedule(dryRun)` 的 `promoted / rescheduled / stillWaiting` 恒 0

- 现状：`reschedule` 的候选条件是「**库里** `scheduleStatus = WAITING`」。
  dryRun 下 `initialAllocate` 不写库，刚被判「候补」的条目在库里仍是 `UNASSIGNED`
  → `reschedule` 看不到它们 → 三个数字全 0。
- **源实现同款瑕疵**（已用断言钉住，没有偷偷"修好"）。
- 影响：管理端「预览排期」的结果页会显示「递补 0 / 调剂 0 / 仍候补 0」，
  但 `autoRejectedIfLocked`（锁定后会被自动驳回几条）是**真实的** —— 也就是
  「最该看的那个数字是对的，过程数字是空的」。
- 两个选项：
  - **A. 保持**（现状，诊断数字不全但主结论正确）
  - **B. 修**：dryRun 时把「将成为候补」的条目当作 `WAITING` 传给 `reschedule`
    （纯内存演练，不改库）
- 我的建议：**B**，理由是这个页面的存在意义就是「锁定前先看会发生什么」。
  改动面很小（一个 `dryRun` 分支），且已有断言可改造。

### ③ `roster.normalizeGrade(2024)` 的返回类型

- 现状：返回**字符串** `'2024'`（与库中 `grade` 字段类型一致）。
- 需要确认的只是「前端 `.vue` 里有没有拿它当数字比」。
  阶段 9 接 admin-web 时如果发现 `grade === 2024` 这种写法要改，我一并处理。
- 当前判定：**无需动作**，但记录在此，避免阶段 9 误判成后端 bug。

---

## 六、验收证据

```
node cloud/scripts/regression.js       # 一键双轮（源码 + 打包产物）
```

| 轮次 | 断言数 |
|---|---|
| 源码目录（13 套件） | 1504 项 |
| 打包产物（11 套件） | 1379 项 |
| **合计** | **2883 项 / 失败 0** |

阶段 7 新增的三条守门脚本：

| 脚本 | 项数 | 钉住什么 |
|---|---|---|
| `test-admin-core.js` | 163 | 93 条路由 × 三种身份的权限矩阵 + 非点歌 63 条接口 |
| `test-admin-submit.js` | 225 | 点歌 30 条 + **排期算法第一次被真实调用**的整链路 |
| `test-admin-student.js` | 263 | 学生账号 19 条 + `roster` / `sheet` 服务（含 base64 往返） |
| `test-admin-routes.js` | 19 | 路由 ↔ handler 就绪性（防「加载失败静默通过权限矩阵」） |

其中**打包产物轮**是必需的：线上跑的是 `sync.js` 打的单文件产物，
打包器靠正则静态分析 `require`，漏收一条就是线上 `Cannot find module`。

---

## 七、遗留（阶段 8 / 9 前置）

1. **`docs/` 里还有「收歌」字样**（已全站改名「点播」，只改了展示名，常量仍 `APPLICATION`）。
   属于文档历史，不做批量替换，避免打断验证脚本的断言期望。
2. **阶段 8 必须补的登记**：存量 admin 需补 `unique_keys` 的 `admin:<username>`；
   存量 user 需补 `user_name:<学号>`。否则云端建号会与历史数据撞名（且**不报错**）。
3. **需陛下在控制台动手**（非代码）：
   - 云函数超时 3s → **20s**
   - 确认触发器页签能看到 `songSweepTick`
