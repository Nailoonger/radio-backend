# 阶段 6 · 定时触发器（原 60s sweep → 云函数定时器）

> ✅ 实施完成（2026-09-28）。本地全量 **829 项**全绿（源码模式与产物模式项数完全一致）。

## 1. 要替换什么

原 `src/services/songQueueService.js` 的 `startScheduler()`：

```js
setInterval(() => { sweep(); }, 60 * 1000);   // 进程内 60 秒 tick
```

云函数**没有常驻进程**，`setInterval` 随实例回收而消失 → 必须换成平台侧定时触发器。

## 2. 为什么不直接「每分钟调一次 sweep」

免费环境（基础套餐）的额度口径：

| 项目 | 额度 |
|---|---|
| 调用次数 | 20 万次/月 |
| **资源使用量** | **10 万 GBs/月** |
| 容量 | 2 GB |

⚠️ **`资源使用量 = 函数配置内存(GB) × 计费时长(s)`**，最小粒度 100 ms。

- 每分钟一次 = `60 × 24 × 30` = **43,200 次/月** → 只占调用次数的 22%，**不紧张**；
- 但若每次都跑满 3 s（256 MB）：`0.25 × 3 × 43,200` ≈ **32,400 GBs = 32% 额度**。

**结论：真正的成本是「时长」，不是「次数」。** 所以正确解法是
**让空转极快返回**，而不是降频（降频会改变行为 —— 原实现就是 60 s 一次）。

## 3. 落地方式

### 3.1 `hasPendingWork(now)` —— 三次廉价查询的「有没有活」闸门

```
① 有没有「还没锁定 / 取消」的周？           weekly_schedule.status ∈ {DRAFT, APPLICATION, REVIEW, SCHEDULING}
② 有没有「还没排上」的点歌？                 submit.scheduleStatus ∈ {UNASSIGNED, WAITING}   ← ⚠️ 不带 type 过滤
③ 有没有「播出日期已到、还没标记播放」的？     submit(type=1, APPROVED, APPROVED, NOT_PLAYED, scheduledSlot < 明天)
```

三次都是 `count()`（只回一个数字），空转单次约 **0.05 GBs ≈ 2% 额度**。

⚠️ **三条都是 `sweep()` 收集范围的「保守超集」** —— 说「没活」时 `sweep()` 必定
`{weeks: [], played: 0}`（一个写操作都不做）。宁可多跑一次，不可漏跑。
这条已被 `test-scheduling.js` 的 W 段钉成断言（`gateIsSafe`，7 个场景）。

### 3.2 `sweepTick({ now, operatorId })` —— 触发器只调这一处

```js
if (!(await hasPendingWork(now))) return { skipped: true, reason: 'NO_PENDING_WORK', weeks: 0, played: 0 };
const r = await sweep({ now, operatorId });          // ← 排期逻辑零改动
...
catch (e) { return { skipped: false, error: e.message, weeks: 0, played: 0 }; }   // 异常绝不外抛
```

**为什么 catch 必须吞异常**：定时任务抛异常会被平台记成「函数执行失败」，污染告警；
下个周期自然重试（`sweep` 幂等）。

**为什么不需要额外的「分钟级幂等锁」**：`sweep()` 里所有改状态都经过
`applyChange` 的**条件 UPDATE**（真乐观锁）—— 冷启动导致同一分钟重复执行时，
抢不到的那次影响 0 行、不计数也不写日志。加一把不原子的分钟锁只会带来**虚假的安全感**。
（已被 `test-scheduling.js` D 段幂等 + U19–U21「sweep 连跑两次无变化」钉死。）

### 3.3 `config.json` —— 触发器配置随函数一起部署

```json
{
  "triggers": [
    { "name": "songSweepTick", "type": "timer", "config": "0 */1 * * * * *" }
  ]
}
```

- **cron 是 7 位**：`秒 分 时 日 月 周 年`（`0 */1 * * * * *` = 每分钟第 0 秒）；
  写 6 位会**静默不触发**。
- ⚠️ 微信云开发**小程序端只支持一个触发器**（CloudBase 文档说最多 10 个，小程序端限制为 1）。
  所以「sweep」只能有一个入口，各分支必须在 `sweep()` 内部区分。
- 触发时 `event = { Type: 'Timer', TriggerName, TriggerTime }`。
- **改了 `config.json` 必须重新部署**（触发器随函数上传，不在平台侧单独配）。

### 3.4 `index.js` —— 定时事件分支插在路由匹配**之前**

```js
if (event && (event.Type === 'Timer' || event.TriggerName)) {
  const out = await sched.sweepTick({ now: Date.now() });
  console.log('[cron]', ...);
  return { code: 0, message: 'ok', data: { cron: true, skipped, reason, weeks, played, error } };
}
```

⚠️ 放在路由匹配**之后**的后果：定时事件没有 `path` → 掉进路由 → 返回「接口不存在」，
**静默失效且日志看不出问题**。产物断言里钉了 `Type === 'Timer'` 与 `sweepTick` 两个字面量。

### 3.5 `sync.js` —— 复制 + 严格校验

`cleanDir()` 后复制 `config.json` 到产物根目录，并做**构建期硬校验**：
JSON 可解析 / `triggers` 非空 / `type === 'timer'` / `name`、`config` 齐 / **cron 必须 7 位**。
任一条不过 → `process.exit(1)`。

**宁可构建失败，也不静默传一个永远不生效的触发器。**

## 4. 修掉的一个静默漂移（值得单独记）

第 ③ 条最早写成：

```js
const todayEnd = `${bj.ymd(bj.shifted(now))} 23:59`;
scheduledSlot: _.lte(todayEnd)        // ❌ 想表达「日期 ≤ 今天」
```

注释当时写的是「日期部分是定长 10 字符 → 字典序安全」——**这个断言只在跨天时成立**。
时段值是 `YYYY-MM-DD 中文时段名 时刻`：

| 比较 | 第 11 位开始 | 结果 |
|---|---|---|
| `2026-10-04 早间…` vs `2026-10-05 23:59` | `4` < `5`（第 9 位） | ✅ 小于 |
| `2026-10-05 早间…` vs `2026-10-05 23:59` | `早`(U+65E9) **>** `2`(0x32) | ❌ **不小于** |

→ **当天播出的歌被闸门判成「没活」，要等第二天才被标记已播放**
（原 Express 是 60 s tick、播完即标）。不报错、只是晚一天 —— 最难发现的那类漂移。

✅ 正确写法：**`_.lt('<明天日期>')`**。
日期是定长零填充 → 时间序 == 字典序 → 任何以今天日期开头的串在第 9 位就小于明天日期串。

```js
const tomorrowDate = bj.ymd(bj.shifted(now + 86400000));
scheduledSlot: _.lt(tomorrowDate)     // ✅ 等价于「日期 ≤ 今天」
```

`test-scheduling.js` 的 `W5-0` 把「旧写法为什么错」钉成了可执行断言（先证伪、再验行为），
`W5a` 断言「今天播出、未标记播放」必须命中。

## 5. 与源实现的其它有意差异

| # | 源 | 云 | 原因 |
|---|---|---|---|
| ① | `setInterval` 进程内 60 s | 平台定时触发器 | 云函数无常驻进程 |
| ② | 启动时 `setTimeout(1s)` 补跑一次 | 无 | 云函数没有「启动」这个时机；触发器每分钟跑已覆盖 |
| ③ | `if (NODE_ENV === 'test') return null` 关定时器 | 无此开关 | 触发器在平台侧配置，不在代码里 |
| ④ | 每次 tick 一律全量 `sweep()` | `hasPendingWork` 短路 | 免费额度导向（见 §2） |

## 6. 上线前置（**需人工**）

⚠️ **云函数默认超时仅 3 s**，而 `sweep()` 在处理大量数据时可能更久。
**必须在云开发控制台把超时改成 20 s**（CLI 无此能力）。

## 7. 本阶段新增/修改的文件

| 文件 | 变更 |
|---|---|
| `cloud/cloudfunctions/api/services/scheduling.js` | +`hasPendingWork` / `sweepTick`（修 ③ 的字典序 bug） |
| `cloud/cloudfunctions/api/index.js` | +定时事件分支（路由匹配之前） |
| `cloud/cloudfunctions/api/config.json` | **新建**（触发器） |
| `cloud/scripts/sync.js` | 复制 `config.json` + 构建期硬校验 |
| `cloud/scripts/selfcheck.js` | 产物目录/触发器/cron 断言（75 → 82 项）；`ok_contains` 兼容字符串 |
| `cloud/scripts/test-scheduling.js` | **+W 段 39 项**（234 → 273 项） |
| `cloud/scripts/test-bundle.js` | 产物目录断言 2 → 3 个文件 |
