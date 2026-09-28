# 阶段 8 · 数据迁移操作手册

> 方案：`cloud/docs/stage8-migration-plan.md`
> 断言：`node cloud/scripts/test-migration.js`（75 项，已纳入 `regression.js`）

## 一句话

**只 SELECT 原库 → 落盘成 JSON Lines → 云开发控制台导入 → 控制台导出 → 双向校验。**

全程不写原库、不改原代码，产物可审阅、可重跑。

---

## 三步

### 1. 导出（本机 / 服务器上跑，只读原库）

```bash
node cloud/migration/export.js
```

连哪个库由原后端的环境变量决定（`DB_DIALECT` / `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`）。
想先拿本地库试跑：

```bash
DB_DIALECT=sqlite DB_STORAGE=./data/_shot.db node cloud/migration/export.js
```

产物在 `cloud/migration/out/`：

| 文件 | 用途 |
|---|---|
| `<collection>.jsonl`（超 5000 行会分片成 `-2` `-3` …） | 逐集合导入云数据库 |
| `unique_keys.jsonl` | 导入 `unique_keys` 集合 —— **唯一性补登记，漏了能建重名账号且不报错** |
| `sequence.jsonl` | 导入 `sequence` 集合 —— **计数器预置，漏了新建记录会与历史 id 撞号** |
| `_snapshot.json` | 第 3 步校验的基线 |
| `_report.json` | 本次的 warning / error |

⚠️ 结尾若打印 `error N 条`，**那些行没有导出**，必须先处理再继续。

### 2. 导入（云开发控制台）

控制台 → 数据库 → 逐集合「导入」→ 选对应 `.jsonl` → 冲突处理模式选 **Upsert**。

需要导入的集合 = 16 张业务表 + `unique_keys` + `sequence`。

⚠️ 三个硬约束（官方要求，写错不会报错、只会在后面莫名其妙）：
1. 文件必须是 **JSON Lines**（一行一条，不是数组）—— 脚本已经这么产出了；
2. 时间必须是 **ISODate 格式** `{"$date": "2018-08-31T17:30:00.882Z"}` —— 脚本已经这么产出了；
   写成裸 ISO 字符串的话，导入后是**字符串**，`_.gte(new Date())` 这类时间条件全部静默失效；
3. Upsert 模式下重复导入会**覆盖**，所以「同 `_id` 字段不同」是真实风险 —— 第 3 步会查。

### 3. 校验（双向）

控制台 → 逐集合「导出」JSON → 放进 `cloud/migration/cloud-dump/`，
**文件名必须与集合名一致**（`submit.json`、`weekly_schedule.json`、`unique_keys.json`、`sequence.json` …）。

```bash
node cloud/migration/verify.js
```

看两个方向：

- **正向**：源库每一行，云库都必须有一份，`_id`/`id` 对得上、**逐字段值相等**（含 NULL）
- **反向**：云库每一份，源库都必须有对应行 —— 多出来的就是孤儿（重复导入 / 手抖补数据）

外加两项结构检查：`unique_keys` 有没有少登记、`sequence` 值对不对。
这两项错了**不体现在行数上**，但会让线上行为错得很隐蔽。

---

## 到底迁移了什么

| 项 | 规则 |
|---|---|
| 表 | 16 张（`song_quota` 已退役，不迁移） |
| 数字主键 `id` | **原样带过去**（BIGINT UNSIGNED 经 mysql2 返回的是字符串，已 `Number()` 归一） |
| `_id` | 12 张自增表交给云端；4 张业务键表 = `setting:<key>` / `switch:<key>` / `ack:<openid>:<noticeKey>` / `week:<weekStartDate>` |
| 字段名 | 一律**驼峰**（= Sequelize 属性名 = 前端 JSON 名），零改名 |
| `weekStartDate` | **保持 `'YYYY-MM-DD'` 字符串**（DATEONLY；转成 Date 会让 `_id` 拼成 `week:Mon Oct 05 2026…`） |
| `cleanup_log.disabledAccounts` | TEXT(JSON) → 数组/对象；解析失败**保留原串并告警**（绝不静默置空） |
| NULL | 原样保留（`program.broadcastDate` 的 NULL 有业务含义） |
| 密码哈希 | **跟着走**（`user` 的 defaultScope 排除 password，导出时显式带） |

---

## 出问题时

| 现象 | 先看 |
|---|---|
| 导出行数比预期少 | `out/_report.json` 的 `errors`（业务键为空 / id 重复 / id 非法都会跳过并记账） |
| 校验报一堆「字段不一致」 | 八成是云库导出的文件**放错目录或文件名不对**（按文件名认集合） |
| 校验说 `sequence` 不对 | 检查 `sequence.jsonl` 有没有导入；值应为 `max(id)`，不是 `max(id)+1` |
| 导入后后台登不上 | 检查 `admin.jsonl` 里有没有 `password` 字段（空的话是导出时没带 `withPassword` scope） |
