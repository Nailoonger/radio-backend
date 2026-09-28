# 阶段 8 · 数据迁移脚本 + 双向校验

> 上游：`cloud/docs/data-model-mapping.md`（17 张表 → 17 集合、主键口径、`unique_keys` 8 个 scope）。
> 下游：阶段 9（admin-web 接云开发）依赖本阶段把存量数据搬过去之后才能真机验证。
> 状态：**方案 + 实现 + 断言已完成**，待真机跑一次导出/导入/校验。

---

## 一、目标与边界

| 项 | 约定 |
|---|---|
| 对原库 | **只 SELECT，绝不写**。`export.js` 全程 `findAll({ raw: true })`，不含任何 `sync/INSERT/UPDATE` |
| 对原代码 | **一行不改**。`src/` 下的模型只是「读」的对象 |
| 产物 | 落盘到 `cloud/migration/out/`，**可审阅、可 diff、可回滚**（重跑即覆盖，不碰云库） |
| 幂等 | 导出重跑安全；导入用云开发控制台 **Upsert** 模式可重复 |
| 不迁移 | `song_quota`（已退役，mapping §二.11 明确 ⛔） |

---

## 二、导入路径的选择（三选一，选 A）

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 控制台导入 JSONL** | 导出 JSON Lines，控制台逐集合点「导入」 | ✅ **选它**。零新增线上接口、零新依赖；日期用官方 ISODate 格式 `"t": {"$date": "2018-08-31T17:30:00.882Z"}` —— 已在微信官方文档核实 |
| B. 临时云函数 `migrate` | 新增一个云函数接收 chunk 写入 | ❌ 多一个部署单元 + 多一份要清理的线上代码 |
| C. `cloudbase` CLI | 需新增 npm 依赖（当前 `package.json` 无） | ❌ 引入依赖，且不解决「导出端」的可测试性 |

⚠️ A 的三个硬约束（官方原文，已核实）：
1. **JSON Lines**，不是数组 —— 记录之间用 `\n` 分隔；
2. 键名首尾不能是 `.`、不能含连续 `.`；
3. 时间必须写成 `{"$date": "<ISO>"}` —— **写成裸 ISO 字符串会被当成普通字符串**，之后 `_.gte(new Date())` 这类时间条件全部静默失效。

---

## 三、表级规则

`cloud/migration/tables.js` 是**唯一声明处**。规则分三类：

### 3.1 `_id` 规则

| 类型 | 表 | `_id` |
|---|---|---|
| 自增（数字 `id` 原样带过去，`_id` 由云端生成） | 其余 12 张 | 不指定 |
| 业务键 | `system_setting` | `setting:<key>` |
| 业务键 | `system_switch` | `switch:<key>` |
| 业务键 | `notice_ack` | `ack:<openid>:<noticeKey>` |
| 业务键 | `weekly_schedule` | `week:<weekStartDate>` |

⚠️ 业务键的三张表（setting/switch/ack）若键位为 NULL/空 → **记 error 并跳过该行**，绝不能拼出 `setting:null`（会静默把所有 NULL 行塌成一条）。
`weekly_schedule.weekStartDate` 是 `DATEONLY`（`'YYYY-MM-DD'` 字符串），**不能**转成 Date —— 转了 `_id` 就变成 `week:Mon Sep 28 2026...`，周行再也查不到。

### 3.2 `sequence` 预置（防 id 撞号）

`nextId()` 的语义是「`sequence.value` = 已发出的最后一个 id，取号时先 `inc` 再返回」。
⇒ **预置 `value = max(id)`**（不是 `max(id)+1`，那会白跳一号）。空表预置 `0`。

> 即便不预置，`nextId` 也有「首次建计数器取 max(id)+1」的兜底（见 `lib/db.js`）。
> 但**显式预置**是更好的做法：它把「历史 id 空间」变成可断言的产物，而不是依赖运行时兜底。

### 3.3 `unique_keys` 补登记 ⭐ 本阶段最容易漏的一步

文档库没有 UNIQUE 索引，靠 `unique_keys` 集合的固定 `_id` 模拟。
**存量数据搬过去之后，`unique_keys` 是空的** —— 不补登记的后果：云端可以再建一个同名管理员 / 同学号用户，**且不报错**。

| scope | 键 | 何时登记 | 当前代码是否真的读 |
|---|---|---|---|
| `admin` | `<username>` | 恒登记 | ✅ `adminMgr.js` |
| `user_name` | `<username>` | **非 NULL** | ✅ `roster.js` |
| `user_openid` | `<openid>` | **非 NULL** | ✅ `user/auth.js` |
| `user_seat` | `<grade>:<classNo>:<seatNo>` | 三者**都**非 NULL | ❌ 代码未读（原 MySQL 有 `uk_grade_class_seat`，按「忠实迁移约束」登记） |
| `setting` / `switch` / `ack` / `week` | 各自业务键 | 恒登记 | ❌ 这 4 张靠 `_id` 本身保证唯一（`insertWithId`），登记属冗余双写 |

⚠️⚠️ **NULL 一律不登记**：
MySQL 的 UNIQUE 允许**多行 NULL**（学生账号的 `openid` 就是 NULL、老微信用户的 `username` 是 NULL）。
若把 `user_openid:null` 登记进去，就只剩一行能占这个键 —— 与 MySQL 语义相反。
⇒ 判据：`username/openid` 为 `null`/`''` → 跳过；`grade/classNo/seatNo` 任一为空 → 跳过。

---

## 四、字段级变换

| 变换 | 说明 |
|---|---|
| 数字 `id` 归一 | ⚠️ `notice_ack.id` / `cleanup_log.id` 在 MySQL 是 **BIGINT UNSIGNED**，mysql2 默认把 BIGINT 返回成**字符串**。不 `Number()` 归一，前端按 id 跳详情会拿到 `undefined`，且不报错。 |
| 时间归一 | 仅 `key === 'DATE'` 的字段：`string/number → new Date()`。**DATEONLY 保持字符串**（见 3.1）。 |
| `cleanup_log.disabledAccounts` | 原为 TEXT(JSON)。尝试 `JSON.parse`；**失败则保留原字符串并记 warning**（不静默丢数据）。 |
| NULL | **原样保留**（`program.broadcastDate` 的 NULL 有业务含义：weekly 接口据此不显示）。 |
| 其它字段 | 原样搬。字段名已是驼峰（= Sequelize 属性名 = 前端 JSON 名），零改名。 |

---

## 五、双向校验（`cloud/migration/verify.js`）

「双向」= 两个方向都不留孤儿：

| 方向 | 判据 |
|---|---|
| **正向**（源 → 云） | 源库每一行，云库都必须有一份，`_id` 一致、**逐字段值相等**（含 NULL） |
| **反向**（云 → 源） | 云库每一份，源库都必须能找到对应行 —— 多出来的就是孤儿（重复导入 / 手抖补数据） |
| **计数** | 每表 `源行数 === 云库文档数` |
| **结构** | `unique_keys` 应覆盖的键数、`sequence.value === max(id)` |

⚠️ **`_id` 相同的两份文档字段不同，必须报出来**（Upsert 模式下重复导入最容易产生这个）。

### 反向用例（必须存在，否则校验是假的）

`cloud/scripts/test-migration.js` 里除了「干净数据全绿」，还必须造**四种坏数据**，断言 `verify()` **全都抓到**：

1. 源有、云缺（漏导入一行）
2. 云有、源缺（多导入一行 → 孤儿）
3. 同 `_id`、字段被改（Upsert 覆盖错）
4. `sequence.value` 少 1（会导致新建记录与历史 id 撞号）

> 依据：静默漂移 #23 的教训 —— 「把恒 X 改成真实值」必须补反向用例。
> 这里同理：一个永远返回「无差异」的 `verify()` 在干净数据上也是全绿的。

---

## 六、闭环断言：迁移产物真的能被云函数读

只比字段不够 —— 还得证明「搬过去的数据云函数能正常消费」。
`test-migration.js` 用 harness 把迁移产物灌进内存假库，然后：

| 断言 | 证明什么 |
|---|---|
| 存量管理员用**原 bcrypt 哈希**能登录，拿到 JWT | `admin` 表 + `unique_keys(admin:)` 迁移正确、密码哈希没丢 |
| `/user/switch/list` 返回迁移过来的开关行 | `system_switch` 的 `switch:<key>` `_id` 规则正确 |
| 存量周行能被 `findOne({ weekStartDate })` 命中 | `week:<date>` `_id` 规则正确 + `weekStartDate` 仍是字符串 |
| `nextId()` 取的号 > 历史最大 id | `sequence` 预置值正确（撞号防护真的生效） |

---

## 七、产物与操作手册

```
cloud/migration/out/
  <collection>.jsonl       # 控制台导入用（JSON Lines，$date 包装）
  unique_keys.jsonl        # 唯一键补登记（导入到 unique_keys 集合）
  sequence.jsonl           # 计数器预置（导入到 sequence 集合）
  _snapshot.json           # 校验基线（含行数统计，Date 用 $date 包装）
  _report.json             # 本次导出的 warning / error
```

陛下真机操作（**顺序不能乱**）：

```bash
# 1) 导出（只读原库；DB_* 指向生产 MySQL）
node cloud/migration/export.js

# 2) 云开发控制台 → 数据库 → 逐集合「导入」out/<collection>.jsonl（Upsert 模式）
#    unique_keys / sequence 两个集合同样导入

# 3) 控制台 → 逐集合「导出」JSON → 放进 cloud/migration/cloud-dump/<collection>.json

# 4) 双向校验
node cloud/migration/verify.js
```

⚠️ 第 3 步的**导出文件名必须与集合名一致**（`submit.json`、`weekly_schedule.json` …），
`verify.js` 按文件名认集合。

---

## 八、断言规模

`cloud/scripts/test-migration.js` —— **75 项 / 失败 0**，已纳入 `regression.js` 套件清单（源码轮 + 产物轮都跑）。

分层：A 段 transform 30 条 / B 段唯一键 13 条 / C 段计数器 4 条 / D 段干净数据 6 条 /
E 段**反向用例 8 条** / F 段闭环（harness 真消费迁移产物）14 条。

---

## 十、实施记录（2026-09-29）

方案之外，真机试跑时**又抓到两个坑**，都已修 + 补断言：

1. **`Model.findAll({ raw: true })` 会把「驼峰别名」和「裸下划线列名」两份都选出来**
   （模型里既有显式属性 `createTime`，又开了 `timestamps: true`）。
   SQL 实测：`SELECT ..., create_time AS createTime, ..., create_time`。
   → 不处理的话云文档里会同时出现 `createTime` 与 `create_time`，违反「字段名一律驼峰」。
   修：`export.js` 的 `snakeDupesOf(Model)` 生成映射，transform 里**只在驼峰版本确实存在时**才删。
   断言 A28–A30（含「只有裸列名时不删」这条保护）。
   → 已登记为静默漂移 **#12**。

2. **源快照与云库导出必须走同一套 wire 编解码**
   第一版测试直接拿内存里的原生对象去比，结果冒出 **30 条假差异**（快照写了 `{$date}`，
   云库侧是 `Date`）—— 正好是真实链路会踩的坑：中间必经 JSON，两侧口径必须对称。
   修：① 测试里两侧都走 `toWire → JSON → fromWire` 真实往返；② `sameValue` 里加容错，
   一侧还是未还原的 `{$date}` 包装时自动还原（**不靠调用方自觉**）。
   断言 D06 / F07–F10。→ 已登记为静默漂移 **#11**。

另外把 `regression.js` 里 `test-admin-routes.js` 的 `bundleCapable` 从 `true` 改成 `false` ——
它自己会检测「目标不是源码目录」并 `[skip]` 退出（产物是单文件、没有 `handlers/`，
路由就绪性守门本就只对源码有意义）。留着 `true` 只会让 `regression.js` 报「无结论行」的假警报。

**已跑通的端到端冒烟**（本地 SQLite 库）：
`init-db` → `seed` → `export.js`（16 表 / 11 行 / 0 error）→ 模拟导入 → `verify.js`
（16 表全 OK，源 11 / 云 11，缺 0 / 孤 0 / 字段差 0 / 结构问题 0）。

**回归**：源码轮 1587 项 + 产物轮 1462 项 = **3049 项 / 失败 0**。

---

## 九、未决 / 风险

| # | 事项 | 处理 |
|---|---|---|
| 1 | 控制台导入一次最多多少条 / 是否有大小上限 | 导出时按 **≤ 5000 行一个分片**（`-<n>.jsonl`）规避；真机导入时看提示 |
| 2 | `cadre/staff.avatar` 是 `/uploads/...` 相对路径 | 迁移**保持原值**（兼容期两套并存），云存储迁移不在本阶段 |
| 3 | 导入期间新产生的增量数据 | 迁移窗口内暂停写入；校验脚本只比对 snapshot 快照那一刻 |
| 4 | `user_seat` 登记但代码不读 | 已按「忠实迁移原 MySQL 约束」登记，注释里写明；将来若代码加校验可直接受益 |
