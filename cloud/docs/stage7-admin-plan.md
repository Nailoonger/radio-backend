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

## 五、陛下裁决与实施（2026-09-29）

原本列了三件待定夺。陛下裁决：**①选 B、②选 B**、③维持现状。

### ① `stats.overview` 的 `approved` 口径 —— **已按裁决实施（B）**

- 裁决：改成 `status ∈ {1, 5, 6}`（已排期 + 已播放 + 已通过·待排期）。
- 理由：卡片标题写的就是「已通过」，而旧口径 `status: 1` 在派生镜像语义下只表示
  「已排期」，把「审核过了还没排期」（`6`）和「已经播完」（`5`）一起漏掉 —— 数字偏小且不报错。
- 落地：`handlers/admin/stats.js` 的 `overview()` 改成 `count(C.SUBMIT, { status: _.in([1, 5, 6]) })`。
- 断言：`test-admin-core.js` 里**专门补了两条样本**（`status: 5` 的「夜曲」、`status: 6` 的「稻香」，
  `createTime` 取 30 天前以免撞 `thisWeek` / `submit-trend`），`approved` 期望值 `1 → 3`。
  只有 `status:1` 一条样本时新旧口径都是 1 —— 改了实现断言也不会变，等于没测。
- ⚠️ **孪生位置 `topSongs()` —— 陛下同日第二次点头，已一并实施（2026-09-29）**：
  where 从 `{ type: 1, status: 1 }` 改成 `{ type: 1, status: _.in([1, 5, 6]) }`。
  理由：它与 `overview.approved` 是**同一个「已通过」语义**，两处口径必须一致 ——
  否则「热门点歌」榜会漏掉已播放的歌（一首歌播完了反而不算热门，明显反直觉）。
  断言同步重推：种子 s5 的歌名改成与 s3 同名「晴天」→ 期望 `晴天×2 + 稻香×1`。
  这条断言能区分新旧实现（旧口径下已播放的那次不算，晴天只有 ×1）；
  并保留负向：待审(0) 与已驳回(2) 仍不进榜 —— 口径放宽 ≠ 全收。
- ✅ 阶段 9 复核：`Dashboard.vue` / `MainLayout.vue` 都**没有**渲染 `overview.approved`
  （卡片只用 total / today / pending），所以「已通过」卡片的文案问题**不存在**，无需改前端。
  （原计划里那条「文案改成已通过 · 已排期」是基于「有这张卡」的假设，实施时核实后取消。）

### ② `previewSchedule(dryRun)` 的 `promoted / rescheduled / stillWaiting` 恒 0 —— **已按裁决实施（B）**

- 裁决：修。原话理由：**「这个页面的存在意义就是『锁定前先看会发生什么』」**。
- 根因（比原描述多一层）：正式锁定路径是 `initialAllocate()`（写库）→ `reschedule()`（写库），
  第二步天然读得到第一步的结果。预览跑 `dryRun` 两步都不写库 → 第二步看到的是
  「第一步从没发生过」的世界，于是**两处**失真：
  1. 候选按库查 `scheduleStatus = WAITING` → **一条都查不到** → 三个数字恒 0；
  2. 各格占用还是**落座前**的 → 第一步刚发给别人的座位在第二步眼里仍然空着
     → 会把同一个人塞进两个位置，「模拟后各格占用」双计。
  （原描述只写了 1；2 是实施时才发现的，不修的话数字修好了但占用图会虚。）
- 落地：
  - `services/scheduling.js`：`initialAllocate({dryRun})` 额外返回 `waitingRows`（**整行**，
    非 dryRun 恒空）；`reschedule()` 新增两个 dryRun 专用入参 `extraWaiting`（内存候选，按 id 去重）
    与 `seatedOverride`（内存占用表，**内部拷贝**，不污染调用方的对象）。
  - `handlers/admin/submit.js`：把第一步的 `afterA`（落座后占用）与 `waitingRows` 交给第二步；
    `plan.waiting` 按 id 去重（同一条可能两步都判候补，不去重会列两遍）。
  - **顺带修正 `autoRejectedIfLocked`**：它原先等于「两步合并的 waiting 动作数」，
    在旧实现下是**虚高**的（会把「其实会被调剂到别处的人」也算成会被驳回）——
    预览说「会驳回 1 条」，真锁定那天是 0 条，**连主结论都是错的**。
    现在按**锁定时刻的真实参数**算：`lockWeek()` 是显式 `crossSlot: true`，
    所以闸门关着（点播未截止）时要**另跑一轮纯内存演练**取 `left`。
    于是 `stillWaiting`（看**现在**的闸门）与 `autoRejectedIfLocked`（看**锁定时刻**）
    成了两个不同含义的数字，这正是它们该有的区别。
- 断言改造（`test-admin-submit.js` H 段，14 → 20 条）：
  - `[promoted, rescheduled, stillWaiting]`：`[0,0,0]` → `[0,1,0]`，并钉住调剂目标
    （`${DATE0} 午间 12:20`，成本表 10 档）与「模拟后占用：早间 1 / 午间 1」。
  - `crossSlot=false` 时 `stillWaiting` 为 1、但 `autoRejectedIfLocked` 仍为 0 —— 两个数字含义不同的判据。
  - **反向用例**：拒绝调剂（`allowReschedule: 0`）+ 首选格满 → `autoRejectedIfLocked` 必须是 `1`。
    没有这条，上面那些 `= 0` 的断言用一个「恒返回 0」的坏实现也能全绿。
  - `mkSubmit` 顺带支持 `allow` 覆盖 `allowReschedule`。

### ③ `roster.normalizeGrade(2024)` 的返回类型 —— **裁决：维持现状**

- 现状：返回**字符串** `'2024'`（与库中 `grade` 字段类型一致）。
- 阶段 9 接 admin-web 时若发现 `grade === 2024` 这种写法要改，一并处理。
- 当前判定：**无需动作**，记录在此避免阶段 9 误判成后端 bug。

---

## 六、验收证据

```
node cloud/scripts/regression.js       # 一键双轮（源码 + 打包产物）
```

| 轮次 | 断言数 |
|---|---|
| 源码目录（13 套件） | 1512 项 |
| 打包产物（11 套件） | 1387 项 |
| **合计** | **2899 项 / 失败 0** |

> 上一版是 1504 / 1379 / 2883；①B + ②B 两处修正各带来 **+8**（core +2、submit +6），两轮同步 +8。

阶段 7 新增的三条守门脚本：

| 脚本 | 项数 | 钉住什么 |
|---|---|---|
| `test-admin-core.js` | 165 | 93 条路由 × 三种身份的权限矩阵 + 非点歌 63 条接口 |
| `test-admin-submit.js` | 231 | 点歌 30 条 + **排期算法第一次被真实调用**的整链路 |
| `test-admin-student.js` | 263 | 学生账号 19 条 + `roster` / `sheet` 服务（含 base64 往返） |
| `test-admin-routes.js` | 19 | 路由 ↔ handler 就绪性（防「加载失败静默通过权限矩阵」） |

其中**打包产物轮**是必需的：线上跑的是 `sync.js` 打的单文件产物，
打包器靠正则静态分析 `require`，漏收一条就是线上 `Cannot find module`。

⚠️ **本机沙箱禁止创建子进程**（`spawnSync` 对 `node` / `git` / `cmd` 全返 `EBUSY`），
所以 `regression.js` 在本机只能打印手工命令清单并优雅降级 ——
上表两轮是**手工双跑**出来的，命令见 `cloud/README.md`「本地验证」。

---

## 七、遗留（阶段 8 / 9 前置）

1. **`docs/` 里还有「收歌」字样**（已全站改名「点播」，只改了展示名，常量仍 `APPLICATION`）。
   属于文档历史，不做批量替换，避免打断验证脚本的断言期望。
2. **阶段 8 必须补的登记**：存量 admin 需补 `unique_keys` 的 `admin:<username>`；
   存量 user 需补 `user_name:<学号>`。否则云端建号会与历史数据撞名（且**不报错**）。
3. **需陛下在控制台动手**（非代码）：
   - 云函数超时 3s → 30s —— **✅ 已配（2026-09-29）**
   - 确认触发器页签能看到 `songSweepTick`
