# 点歌前置：注意事项确认 + 播出时段可选化

> 2026-09-18 · 涉及表：`notice_ack`（新）、`system_setting`（3 个键）
> 代码：`src/services/songNoticeService.js`、`src/services/broadcastSlotService.js`、
> `src/controllers/user/submitController.js`、`src/controllers/admin/submitController.js`
> 验证：`node scripts/verify-song-submit.js`（53 项，含名额回归）

## 1. 需求

> 「当用户点进点歌模块的时候设计弹出一个注意事项，前后端都设计使管理员管理平台可以修改这个注意事项内容，
> 里面是点歌注意事项，需要用户翻阅完毕之后滑动到页底点击我已知晓之后才可以开始点歌，
> 点歌播出时间选择不要让用户自己输入，你导入时间系统让用户选择，
> 选择播出时间范围只能在下一个周的周一到周五。」

拆成两条：

| # | 需求 | 落地 |
|---|---|---|
| A | 进点歌模块弹注意事项；管理员可改内容；**滑到页底 + 我已知晓**之后才能点歌 | 内容 + 版本号存 KV；确认记录存 `notice_ack`；提交接口服务端强制校验 |
| B | 播出时间不让用户手输，改成系统下发可选；范围只有**下一周的周一到周五** | `GET /submit/timeslots` 下发；提交时服务端校验取值合法性 |

## 2. A · 注意事项

### 2.1 数据

| 存储 | 键 / 表 | 说明 |
|---|---|---|
| 正文 | `system_setting.song_notice` | 管理员在后台编辑；**留空 = 停用**（用户端不弹、也不拦提交） |
| 版本号 | `system_setting.song_notice_version` | 内容**有变化**才 +1；内容没变再保存一次不动版本 |
| 确认记录 | `notice_ack` | `(openid, notice_key)` 唯一；`version` = 确认时那份内容的版本号 |

### 2.2 版本号是怎么用的

```
needAck  ⇔  该用户 notice_ack.version  <  当前 song_notice_version
```

- 管理员改了内容 → 版本 +1 → **所有人需要重新确认**（避免「改完规则但没人看」）；
- 管理员只是重新保存了一遍、内容没变 → 版本不动 → **不打扰已经确认过的用户**；
- 确认动作幂等：重复确认不报错，服务端取 `min(传入版本, 当前版本)`，防止前端伪造高版本。

### 2.3 闸门在哪

| 位置 | 行为 |
|---|---|
| 前端（小程序） | 进点歌模块先 `GET /submit/notice`；`needAck=true` 时弹全屏注意事项，「我已知晓」按钮在**滚动到页底前禁用** |
| 服务端 | `POST /api/user/submit`（type=1）先校验确认状态；未确认返回 **`40303 NOTICE_UNACKED`**，前端据此弹窗 |

> ⚠️ **诚实说明**：「必须滑到页底」是纯前端交互，服务端**无法验证用户真的读完了**，
> 它只能保证「确认过当前版本」。要更强的约束只能加阅读时长（例如停留 ≥ N 秒），当前没做。

### 2.4 边界情形（都已按下面实现）

| 情形 | 行为 |
|---|---|
| 后台还没配内容 | `configured=false` → 小程序**不弹窗**，提交也不拦（否则功能没上线就把点歌入口堵死） |
| 内容很短、一屏放得下 | 前端检测 `scrollHeight <= clientHeight` → 按钮**直接可用**，不能要求用户去滑一个滚不动的区域 |
| 管理员清空内容 | 等价于停用；版本号仍然 +1（留着痕迹，方便排查「为什么突然不弹了」） |
| 内容超长 | 后端限制 5000 字（返回 40001）；前端区域内部滚动，提示语固定在底部 |

## 3. B · 播出时段

### 3.1 可选范围怎么算

```
可选 = 下一周的周一 ~ 周五   ×   每天的时段（来自 system_setting.broadcast_schedule）
```

- **严格「下一周」**：即使今天是周一，也从下周一算起（按需求原话）。
  按北京时间计算，与容器 TZ 无关（见 `src/utils/bjTime.js`）。
- 每天时段从 `broadcast_schedule`（如 `07:20 / 12:20 / 17:30`）里正则提 `HH:mm`；
  **解析不出来就退回默认三个时段** —— 保证功能不会因为设置没配而不可用。
- 时段名（早间/午间/晚间）按起点小时判断：`<10 早间`、`<15 午间`、`其余晚间`。
- 目前是 5 天 × 3 时段 = **15 个可选值**。

> 没做但可以考虑：把时段与 `program` 表里已排的节目关联起来（选时段时顺便看到当期节目名）。
> 这需要先确认 `program` 的日期字段语义，本次没动。

### 3.2 存什么

沿用原有字段 `submit.want_broadcast_time`（`VARCHAR(64)`，**不需要改表**），
但值由「用户自由文本」改为**系统规范串**：

```
2026-09-21 午间 12:20
```

服务端在提交时用 `broadcastSlotService.isValidSlot()` **重新算一遍合法集合做包含判断**：

- 2099 年的日期 → 拒
- 下周但落在周末 → 拒
- `明天中午` 这种自由文本 → 拒
- 空值 → 拒（返回「请选择希望播出的时段」）

## 4. 接口

### 用户端（都需登录）

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/user/submit/notice` | `{configured, needAck, content, version, ackedVersion}` |
| `POST /api/user/submit/notice/ack` | body `{version}`；幂等 |
| `GET /api/user/submit/timeslots` | `{weekStart, weekEnd, rangeText, periods, list[]}`，`list[].value` 即提交回传值 |
| `POST /api/user/submit` | type=1 时：先过注意事项闸门（40303）+ 时段合法性校验（40001）；再走名额与自动驳回 |

### 管理端（需登录，与现有投稿接口同级权限）

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/admin/submit/notice` | `{content, version, configured, ackedCount}` |
| `PUT /api/admin/submit/notice` | body `{content}`；返回是否 `bumped`（版本是否 +1） |
| `GET /api/admin/submit/timeslots` | 预览「用户能选到什么」，与用户端同源同代码 |

> ⚠️ 路由顺序：`/submit/notice`、`/submit/timeslots` 都注册在 `/submit/:id` **之前**，
> 否则会被 `:id` 吃掉（`routes/user.js`、`routes/admin.js` 都有这个坑，验证脚本里有断言）。

## 5. 迁移

新库：`sql/schema.sql` 已包含 `notice_ack`。

**已有库**：
```bash
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-notice-slot.sql
```
（3 条 INSERT 都可以不执行：正文读不到 = 未配置 = 不拦人；`broadcast_schedule` 缺失会走默认时段。）

## 6. 验证

```bash
node scripts/verify-song-submit.js      # 53 项，SQLite 内存库，不需要 MySQL
```

覆盖：名额（占位 / 自动驳回 / 幂等 / 并发 10 抢 2 不超发）、注意事项（版本号只在内容变化时 +1、
改内容后老确认失效、重复确认幂等、清空=停用、未配置不拦人）、播出时段
（15 个可选、全部落在下周一到周五、value 格式、非法值与自由文本被拒、设置坏了退默认）、
路由挂载与顺序。

## 7. 假设与待定

| # | 假设 | 说明 |
|---|---|---|
| 1 | 「下一个周」= 严格下一周（今天周一也跳到下周一） | 按需求原话；若希望「本周剩余 + 下周」一起可选，改 `bjTime.nextWeekRange` 一处即可 |
| 2 | 时段来源是 `broadcast_schedule`，每天 3 个时段 | 若希望按「每个节目单独一个时段」，需要接 `program` 表（见 3.1 注） |
| 3 | 注意事项对**点歌**生效，文稿不受影响 | 若要给文稿也加一份，`notice_key` 换成 `article_submit`，机制完全一样 |
| 4 | 已确认用户改内容后要求重新确认 | 若希望「改内容不强制重新确认」，`save()` 里不升版本即可 |
| 5 | 未做「阅读时长」校验 | 见 2.3 的诚实说明 |

---

## 8. 追加需求（同日第二轮，2026-09-18）

用户确认/新增四条：

| # | 需求 | 落地 |
|---|---|---|
| 1 | 「下一个周」= **严格下一周**（今天周一也跳到下周一） | 已确认，实现无需改动（`bjTime.nextWeekRange`） |
| 2 | 播出时段**可在后台发布和修改** | 新增 KV `song_slot_times`（JSON）+ `GET/PUT /admin/submit/slots` |
| 3 | **文稿也要一份自己的注意事项** | 注意事项改成「多份」机制，新增 `article` 一份（key = `article_submit`） |
| 4 | 单个同学**一周最多点 2 次**；**一首歌一周内不可重复** | 新增 `submitRuleService` + `GET/PUT /admin/submit/rules` |

### 8.1 时段改由后台发布

时段来源变成三级兜底，**优先级从高到低**：

```
① KV song_slot_times（后台「点歌设置」里维护的 JSON 列表）
② 解析 broadcast_schedule（「07:20 / 12:20 / 17:30」这类文案）
③ 代码里的默认三个
```

- 后台接口：`PUT /api/admin/submit/slots`，body `{times:[{time:"07:20",label:"早间"}, …]}`
  - 最多 **6** 个；格式必须 `HH:mm`；自动按时间排序；`label` 最长 8 字（缺省按时段自动给 早间/午间/晚间）
  - 全非法或空数组 → `40001`；保存后**立即生效**（清 30 秒读缓存）
- `GET /api/admin/submit/slots` 返回 `{times, source, maxSlots, weekStart, weekEnd, rangeText, count}`
  —— `source` 明确告诉后台现在是「你发布的 / 台词解析的 / 默认的」，避免「改了没生效」的困惑。
- **固定不变的部分**：日期范围仍然是**下一周的周一到周五**，不在这里改（需求 1 已定死）。
- 用户端与后台预览**同一份代码**，所以后台看到的 15 个就是用户能选的 15 个。
- 注意：改了时段列表后，**历史记录里存的老时段值依然在库里**（那是历史事实），
  但**新提交**必须落在当前列表里，否则被 `isValidSlot` 拒。

### 8.2 注意事项支持多份

`NOTICES` 注册表：

| type | notice_key | 正文 KV | 版本 KV |
|---|---|---|---|
| `song`（默认） | `song_submit` | `song_notice` | `song_notice_version` |
| `article` | `article_submit` | `article_notice` | `article_notice_version` |

- 用户端：`GET /submit/notice?type=song|article`（缺省 `song`）；确认 `POST /submit/notice/ack {version, type}`
- 管理端：`GET /submit/notice` 一次返回两份；`PUT /submit/notice {type, content}`
- **两份完全独立**：改文稿那份不会让点歌那批人重新确认（验证脚本里有断言）；
  `notice_ack` 表靠 `notice_key` 区分，两份各一行。
- 提交校验也按类型走：`type=1` 查 `song`、`type=2` 查 `article` —— **文稿现在也会被自己的注意事项拦**。
- 加第三份（比如留言）只需在注册表加一行 + 前端多传一个 type，**不动表结构**。

### 8.3 两条提交规则

| 规则 | KV | 默认 | 判定口径 |
|---|---|---|---|
| 每人每周最多点 N 次 | `song_weekly_user_limit` | **2**（0 = 不限） | 本周提交的 `type=1` 条数，**排除 `auto_rejected=1`**（因名额满被系统驳掉的不算学生的错）；人工驳回的算 |
| 同一首歌一周内不可重复 | `song_dup_block` | **1**（开） | 本周内 `type=1` 且 `status ∈ {0,1}` 的记录里已有同名歌 —— **已驳回的不锁**，否则一次误投就把这首歌锁死一周。比较用**归一化歌名**：全角→半角（含全角空格 U+3000）、去所有空白、忽略大小写；库存原文不动，不加列不做迁移（本周候选行很少，取出来在 JS 里比） |

- 两条都不通过时返回 **`40903 SUBMIT_REJECTED`**，message 直接给用户看：
  - `本周已经有人点过《晴天》了，换一首吧`
  - `本周点歌次数已用完（每周最多 2 次），下周再来吧`
- 位置在**内容安全检测之前**：先拦掉注定不能提交的，别浪费一次微信接口调用。
- 用户端 `GET /submit/quota` 顺带返回 `userWeekly:{used,limit,remaining}`，投稿页可以提前显示「本周还剩 1 次」。
- ⚠️ **同曲去重是「查一次再写」的最佳努力校验**：极端并发下两条同名投稿仍可能同时落库。
  同一个人 1 分钟内的重复投稿另有提交限流兜底；要 100% 唯一得给「周 + 歌名」建唯一索引或加锁。
- 归一化**故意不做**的：去括号后缀、去标点、繁简转换 —— 学生手填自由文本，规则定太狠容易误伤。
  坑：全角空格 U+3000 **不在** FF01–FF5E 偏移区间，不能跟其它全角字符一起减 0xFEE0（会得到乱码），要单独映射成半角空格。
- 索引：判定用到 `submit(type, status, create_time)`，v5 已加过这条复合索引。

### 8.4 接口增补

| 端 | 方法 + 路径 | 说明 |
|---|---|---|
| 管理端 | `GET /api/admin/submit/slots` | 当前生效时段 + 来源 + 日期范围 |
| 管理端 | `PUT /api/admin/submit/slots` | 发布 / 修改时段 |
| 管理端 | `GET /api/admin/submit/rules` | 两条提交规则 |
| 管理端 | `PUT /api/admin/submit/rules` | 改两条提交规则 |
| 用户端 | `GET /api/user/submit/notice?type=` | 点歌 / 文稿各自的注意事项 |

### 8.5 迁移与验证

```bash
# 已有库（只加 KV 设置项，不建表不改表；不执行也能跑，因为代码里都有默认值）
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-rules.sql

# 验证：现在是 86 项
node scripts/verify-song-submit.js
```

新增断言（除原有 53 项外）：两份注意事项版本互不影响 / 确认记录各一行 / 默认每周 2 次且拦截第 3 次 /
系统自动驳回不占个人次数 / 已驳回的歌可以再点 / 规则改动立即生效 / 后台发布时段后来源变 `custom` 且按时间排序 /
时段格式非法与空列表被拒 / 超过 6 个截断 / 新增 4 条路由已挂载且在 `/submit/:id` 之前。
