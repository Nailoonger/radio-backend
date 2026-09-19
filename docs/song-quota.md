# 点歌名额（每日 / 每周上限 + 超额自动驳回）

> 2026-09-18 · 涉及表：`song_quota`（新）、`submit`（加字段）、`system_setting`（加两个键）
> 代码：`src/services/songQuotaService.js`、`src/controllers/admin/submitController.js`、`src/controllers/user/submitController.js`

## 1. 规则

1. 管理员可设置**每日**、**每周**两个点歌名额上限（`0` = 不限制）。
2. 管理员每**通过**一条点歌，占用一个名额（日 + 周同时占）。
3. 某个周期名额被占满的那一刻：
   - 该周期内**剩余所有待审点歌**由系统自动驳回（`auto_rejected = 1`，带固定理由）；
   - 之后**新提交**的点歌也会立刻被系统驳回（仍落一条记录，学生在「我的投稿」里能看到原因）。
4. **文稿投稿不受任何影响** —— 名额只管点歌（`type = 1`）。
5. 管理员可以手动改判：人工驳回会把 `auto_rejected` 归零；删除一条已通过的点歌会**归还**名额。

### 需求里没写、我按下面假设做的（不对就说，改动很小）

| # | 假设 | 理由 |
|---|---|---|
| 1 | 「当日」= **提交时间**在当天（北京时间 00:00–24:00），不是「希望播出日」 | `submit` 表没有播出日期字段，`want_broadcast_time` 是自由文本，没法当依据 |
| 2 | 周上限也**同样**触发自动驳回（周内剩余待审全部驳回） | 与日上限行为一致，否则周上限只是个装饰 |
| 3 | 一周 = **周一 00:00 起**的 ISO 周（北京时间） | 国内习惯周一起；跨年那一周按 ISO 规则归属 |
| 4 | 名额满了之后新提交**先落库再自动驳回**，而不是直接报错 | 学生在「我的投稿」能看到「名额已满」的原因，比一个报错提示清楚 |
| 5 | 名额上限调小到低于当前用量时，**立刻按已满处理**并触发一次自动驳回 | 否则「调小了却没生效」更费解 |
| 6 | 超管也不能突破名额（要放行就先调大上限） | 名额本身就是管理员自己设的，没必要再开后门 |

## 2. 表设计

### 2.1 `song_quota`（新增）—— 名额计数器

```sql
id            BIGINT UNSIGNED PK
period        TINYINT       -- 1=日 2=周
period_key    VARCHAR(10)   -- 日=2026-09-18；周=2026-W38
used          INT UNSIGNED  -- 本周期已通过的点歌数
exhausted_at  DATETIME      -- 名额用尽时刻（只用于展示/排查）
create_time / update_time
UNIQUE KEY uk_period_key (period, period_key)   -- ← 并发正确性的地基
```

**为什么不用 `COUNT(*)`？** 两个原因，第二个是致命的：

1. `COUNT` 是扫描。并发放大的时候，每次审核都要扫一遍当天/当周的点歌；
2. **它没法原子「占位」。** 先 `COUNT` 再 `INSERT/UPDATE` 是经典的 check-then-act：
   两个管理员同时点「通过」→ 都读到 19/20 → 都放行 → 实际放出 21 个名额。
   在 `REPEATABLE READ` 下快照读也是旧的，加 `SELECT ... FOR UPDATE` 又得额外锁一堆行。

计数器的做法把「判定」和「占位」压成**同一条 UPDATE**，天然原子。

### 2.2 `submit.auto_rejected`（新增）

`TINYINT NOT NULL DEFAULT 0`。用途：
- 后台列表把「系统自动驳回」和人工驳回**分开显示**（用不同标签）；
- 让自动驳回可以幂等重跑（`WHERE status = 0`）；
- 排查「这条为什么被驳了」。

### 2.3 索引

```sql
KEY idx_type_status_create (type, status, create_time)   -- submit 新增
```

自动驳回是一条批量 UPDATE，条件是 `type=1 AND status=0 AND create_time BETWEEN`。
顺序必须是 `type → status → create_time`：先按类型切掉文稿，再只看待审，最后卡时间区间。
只在 `create_time` 上单独建索引不够 —— 待审的那一小撮会被全表的状态扫描淹没。

### 2.4 设置项（`system_setting` KV）

`song_quota_daily` / `song_quota_weekly`，值为整数，`0` 或空 = 不限制。
落 KV 而不是新建配置表，是为了复用已有的 `/admin/setting/*`（含权限、审计、后台设置页）。

## 3. 并发方案（重点）

### 3.1 占名额：一条带条件的 UPDATE

```sql
UPDATE song_quota
   SET used = used + 1
 WHERE period = :period AND period_key = :key AND used < :limit;
```

- **命中 1 行** = 抢到名额；**命中 0 行** = 名额已满（或本周期行还没建）。
- InnoDB 会对这一行加排他锁，同一周期的并发请求在这条语句上**天然串行**——
  不需要显式锁，不需要 `FOR UPDATE`，也不存在锁顺序问题。
- 判定条件（`used < :limit`）写在 `WHERE` 里，和自增在同一个语句内完成，
  中间没有任何窗口可以插进来。

对应代码（Sequelize，两种方言通吃）：

```js
await SongQuota.update(
  { used: sequelize.literal('used + 1') },
  { where: { period, periodKey, used: { [Op.lt]: limit } }, transaction }
);
```

### 3.2 本周期行不存在时：INSERT IGNORE，不用 findOrCreate

首建靠 `UNIQUE(period, period_key)` 保证只有一个 INSERT 成功。

> ⚠️ **踩过的坑（已修）**：最初用 `findOrCreate` 补建行。它会开一个额外的 SAVEPOINT 并先 SELECT，
> 并发下直接抛锁异常，而这个异常被我的兜底逻辑吞掉 → 10 个并发请求**全部返回成功**、
> 计数器却是 0，名额形同虚设。改成 `bulkCreate(..., { ignoreDuplicates: true })`
> （MySQL=`INSERT IGNORE`，SQLite=`ON CONFLICT DO NOTHING`）后：10 并发抢 2 个名额 → **成功 2、计数器 2**。

### 3.3 热路径零 SELECT

正常情况（本周期行已存在）占名额只有**一条 UPDATE**，不读计数器、不读设置（上限有 10 秒缓存，
后台保存时主动清缓存）。只有「命中 0 行」时才多一次建行 + 一次重试。

### 3.4 事务边界

占名额必须和「把这条投稿改成已通过」在**同一个事务**里：

```js
await sequelize.transaction(async (t) => {
  // ① 条件更新：只有仍是「待审核」才改 —— 两个管理员点同一条时只有一个能命中
  const [flipped] = await Submit.update({ status: 1, ... }, { where: { id, status: 0 }, transaction: t });
  if (!flipped) return;                       // 已被别人处理，空提交
  // ② 占名额；不够 → 抛错 → 整个事务回滚，状态还原
  const r = await songQuota.claim({ transaction: t });
  if (!r.ok) throw new QuotaExhaustedError(r);
});
```

- 顺序是**先改状态、后占名额**：名额不足时回滚，不会留下「占了名额但没通过」的脏数据；
  反过来（先占后改）一旦状态更新失败，名额就白扣了，得写补偿逻辑。
- ①的 `WHERE status = 0` 同时解决「同一条被点两次」的并发重复占位。
- **事务内不要做任何外部 IO**（微信接口、HTTP）。计数器那行锁在事务提交前一直持有，
  期间同周期的其它审核都会排队等它。

### 3.5 自动驳回：事务提交后执行 + 幂等

```sql
UPDATE submit SET status = 2, reject_reason = :系统理由, auto_rejected = 1, review_time = NOW()
 WHERE type = 1 AND status = 0 AND create_time >= :periodStart AND create_time < :periodEnd;
```

- 放在**提交之后**（`setImmediate`）执行：它是一次批量写，不该拖长审核事务、也不该被事务回滚牵连。
- `WHERE status = 0` 让它**幂等**：重复跑只会命中更少的行，绝不会改动已通过 / 已人工驳回的记录。
- 触发点有三处：① 审核通过刚好占满；② 用户在已满时提交；③ 管理员手动点「立即执行自动驳回」。
  即便三处都漏了，后台「名额」面板会显示「名额已满但仍挂着 N 条待审」，一点就补上。

### 3.6 计数尽量不做「读-改-写」

归还名额（删除已通过的点歌）用的是 `SET used = used - 1 WHERE used > 0`，
同样是一条语句搞定，没有先读后写。

### 3.7 多实例安全

所有状态都在 MySQL 里，**没有进程内计数器**。所以 pm2 cluster、多容器
（`docker compose up --scale radio-backend=2`）下也是同一套判定。
唯一有缓存的是「上限值」（10 秒 TTL），它只影响「什么时候按新上限判定」，不影响是否超发。

## 4. 时区（一个真实的坑）

- 后端容器**没有设 `TZ`**，进程时区是 UTC；而 MySQL 容器是 `Asia/Shanghai`，
  `submit.create_time` 由 MySQL 写，是北京时间。
- 所以日/周边界**不能**用裸 `dayjs()` 算 —— 那样「今天」会从北京时间早上 8 点开始。
- `songQuotaService` 里全部按固定 `+08:00` 计算 key 与时间区间（读回来的 Date 交给
  Sequelize 按 `timezone: '+08:00'` 序列化），**与进程 TZ 无关**。
- 顺带建议：给 `docker-compose.yml` 的 `radio-backend` 补上 `TZ: Asia/Shanghai`，
  让「作品里其它地方」的日志时间也统一。这不影响本模块的正确性。

## 5. 失败策略（写死在代码注释里）

| 路径 | 表不存在（迁移没跑） | 其它异常 |
|---|---|---|
| 写：占名额 / 读上限 | 降级为「不限制」+ 打日志 | **上抛** → 事务回滚 → 本次通过失败并报错 |
| 读：占位状态 / 自动驳回 | 降级为「未满」+ 打日志 | 打日志，按「未满」返回 |

理由：名额是**限制器**，读抖动最多让提示不准（还有 sweep 兜底），
但写路径如果把「数据库出错」当成「不限制」，一次抖动就能把当日名额全放开 —— 那才是真的失控。
宁可让管理员重试一次，也不超发。

## 6. 接口

| 端 | 方法 + 路径 | 说明 |
|---|---|---|
| 管理端 | `GET /api/admin/submit/quota` | 快照：日/周 `{limit, used, remaining, exhausted, periodKey}`、`pendingWhileExhausted`、`autoRejectedToday` |
| 管理端 | `PUT /api/admin/submit/quota` | 设置 `{daily, weekly}`，`0`=不限；调小后立即按已满处理并扫一次 |
| 管理端 | `POST /api/admin/submit/quota/sweep` | 手动触发自动驳回（幂等） |
| 管理端 | `PUT /api/admin/submit/:id/approve` | 名额不足返回 `40902 QUOTA_EXHAUSTED`（日/周、已用/上限都写在 message 里） |
| 管理端 | `POST /api/admin/submit/batch` | 逐条走同一套流程；中途名额用尽则保留已成功的，其余回 `skipped` |
| 用户端 | `GET /api/user/submit/quota` | 投稿页提前提示「名额已满，还剩 N 个」 |
| 用户端 | `POST /api/user/submit` | 已满时仍落库，但立刻置为系统驳回，响应带 `autoRejected: true` + 原因 |

> ⚠️ 路由顺序：`/submit/quota` 必须注册在 `/submit/:id` **之前**，否则会被 `:id` 吃掉。
> 已在 `routes/admin.js`、`routes/user.js` 里按此顺序放置，并有校验（见验证记录）。

## 7. 迁移与对账

新库：`sql/schema.sql` 已包含（`song_quota` 表、`submit.auto_rejected`、复合索引）。

**已有库**（`schema.sql` 只在数据卷首次初始化时执行，改了不生效）：
```bash
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-quota.sql
```

对账：计数器是名额判定的唯一依据。唯一会漂移的操作是**手工在库里删掉已通过的点歌**
（走接口删除会自动归还名额）。怀疑漂移时跑 `sql/migrations/2026-09-18-song-quota.sql`
末尾注释里的对账 SQL，把 `used` 按真实数据修回。

## 8. 验证记录（2026-09-18）

在 SQLite（`DB_STORAGE=:memory:`，与 jest 同构）上把整条链路跑了一遍，**21 项全通过**：

- 上限写入/读出、`0`=不限制（不建行、不占位）
- 顺序占位：限 3 → 前 3 次成功、第 4 次返回 `{ok:false, scope:'daily', limit:3, used:3}`
- 日/周计数器同步计入
- 自动驳回命中 7 条（10 条里 3 条已通过）、重复执行 0 条（幂等）
- 7 条被打上 `auto_rejected=1` 且理由含「名额已满」；**2 条文稿完全不受影响**
- 删除已通过的点歌后名额归还（3→2）
- **并发 10 次抢 2 个名额 → 成功 2、异常 0、计数器 2**（零超发）
- 路由顺序、上限解析（`""`/`"0"`/`"abc"` → 0，`"20"` → 20）

MySQL 上的并发压测还没做（需要先把 Docker 起起来）；结论依据是「单条条件 UPDATE + 唯一键」
这两个与方言无关的机制，SQLite 上已能证明逻辑不超发。

## 9. 待定（等你拍板）

1. 「当日」按**提交时间**算 —— 若应该是「播出日」，需要先给 `submit` 加播出日期字段（改动较大）。
2. 周上限是否也要自动驳回（当前：是）。
3. 名额满了以后，小程序投稿页是「禁用投稿按钮」还是「允许提交但提示会被驳回」（当前：后者）。
4. 要不要给 `radio-backend` 容器补 `TZ: Asia/Shanghai`（不影响本模块，但影响日志时间）。
