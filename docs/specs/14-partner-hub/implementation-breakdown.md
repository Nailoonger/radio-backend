# 伙伴端落地拆解：72 屏 → 小程序页面 / 接口 / 数据集合

整理日期：2026-10-27。对应原型 `preview/partner-hub-gounucai-v151/`（线上 v151）。

本文只回答一件事：**怎么把原型变成能上线的代码**。不含视觉参数（视觉以原型为准）。

---

## 0. 结论先行

1. **72 屏不是 72 个页面**。三组屏（站员 12 / 社干 25 / 超管 30）大量跨角色复用，去重后只有 **32 个独立场景**；再按「一个页面用状态表达多个屏」压缩，**真实页面 21 个**。
2. **已有 6 页可留**：`login / todo / review / review-detail / message / me` 是 2026-10-01 做的一期（审核线），继续用，只补角色分支。
3. **缺口最大的是排班线**：后端 `src/` 与 `cloud/` 都**没有任何人员值班表**（`weekly_schedule` 是点歌排期，别混用），小程序端也没有一页。
4. **落地顺序**：身份 → 值班时段+可排时间 → 生成/调整/发布 → 我的班表+请假+补位 → 考勤+轮值 → 内容线。**不要按屏幕顺序做**，要按数据依赖做。

---

## 1. 入口与身份

### 1.1 已有链路（不用重建）

```
学生登录页 pages/login/login.wxml:89  .admin-entry「管理员登录」
   → wx.navigateTo('/pages-partner/login/login')      （login.js:143 goAdminLogin）
   → POST /api/admin/login { username, password } → { token, admin }
   → 存 admin_token / adminInfo（与学生的 token 分键，同机双登不互踢）
   → 落地 pages-partner/todo/todo
```

### 1.2 需要补的三件事

| 项 | 现状 | 要补 |
|---|---|---|
| 角色路由 | `admin.role`：0=超管、1=社员（社干） | 落地页按 role 分流：0 → 超管工作台，1 → 社干工作台；**站员不进伙伴端**（用学生 token） |
| 岗位资格 | `admin` 表无部门/岗位 | 新增 `dutyRoles[]`（播音/主持/编辑）+ `department`，社干/超管要能进人员池被排班 |
| token 双轨 | 学生 `token` / 管理 `admin_token` | 伙伴端所有请求只认 `admin_token`；`utils/request.js` 需要支持"指定 token 键"，否则会串号 |

> ⚠️ 一期已有教训：伙伴端只读 `admin_token` 与 `adminInfo`，**不要**走 `/user/profile`。

---

## 2. 屏 → 场景 → 页面 的三级压缩

### 2.1 去重后的 32 个独立场景

| 分组 | 场景（原型 id） | 归属 |
|---|---|---|
| 站员独有 | `home` `notices` `schedule` | 站员 |
| 三端共用 | `me` `people`(可排时间) `leave` `my-att` `feedback` `my-drafts` `versions` `editor` `aifind` | 全角色（按权限裁剪动作） |
| 社干/超管共用 | `desk` `attendance` `mgr-schedule` `planning` `draft` `slots-pub` `workload` `history` `leave-approve` `fill` `submissions` `submission-detail` `messages` `review` `song-schedule` `roster` | 社干 + 超管 |
| 超管独有 | `accounts` `rules` `att-overview` `timeslots` | 超管 |

### 2.2 压缩成 21 个页面（6 已有 + 15 新增）

一个页面吃多个屏（用 `state` 表达），例如 `schedule/draft` 一页吃「未排班 / 草稿 / 已发布 / 已撤回」四屏。

```
pages-partner/                      分包（已在 app.json:64 注册）
├─ login/                  ✅已有  管理员登录
├─ todo/                   ✅已有  待办台（保留：登录后的轻落地页）
├─ desk/                   🆕     工作台：欢迎卡 + 大白卡轮播 + 待办/管理块（吃 desk × 3 屏）
├─ review/                 ✅已有  审核列表：三段状态 × 三类（点歌/文稿/留言）
├─ review-detail/          ✅已有  审核处理台
├─ message/                ✅已有  留言审核（可与 review 合并，暂留）
├─ me/                     ✅已有  我的（个人介绍 + 天数 + 五个入口）
├─ schedule/
│   ├─ index               🆕     班表（吃 schedule / mgr-schedule：我的班表、整周班表、四态）
│   ├─ planning            🆕     排班工作台（吃 planning + draft：生成/换人/固定/校验/发布/撤回）
│   ├─ slots               🆕     值班时段（吃 slots-pub + timeslots：配置/发布/只读三态）
│   ├─ rules               🆕     排班规则（超管；社干只读）
│   ├─ workload            🆕     人员轮值情况
│   └─ history             🆕     发布与调整记录
├─ availability/           🆕     可排时间填报（吃 people：按天分组的能来/不能来方块）
├─ attendance/             🆕     考勤（吃 attendance / my-att / att-overview 三态）
├─ leave/                  🆕     请假（吃 leave / leave-approve / fill 三态）
├─ work/                   🆕     稿件（吃 my-drafts / editor / versions / aifind）
├─ roster/                 🆕     伙伴名册（吃 roster）
├─ accounts/               🆕     账号管理（吃 accounts；超管）
├─ feedback/               🆕     互评（吃 feedback）
└─ notices/                🆕     站内公告（吃 notices；或复用学生端 pages/notices）
```

**不做（明确划到电脑端）**：模块开关、系统设置、数据看板、批量导出。原型里超管 hint 已写明。

---

## 3. 页面 → 接口 → 集合 对照表

### 3.1 排班线（核心，全部新增）

| 页面/动作 | 接口 | 集合 |
|---|---|---|
| 值班时段 读（草稿+生效版） | `GET /partner/slots` | `duty_slot_versions` |
| 值班时段 只读生效版 | `GET /partner/slots/published` | `duty_slot_versions` |
| 值班时段 存草稿 | `PUT /partner/slots/draft` | `duty_slot_versions` |
| 值班时段 发布 | `POST /partner/slots/publish` | `duty_slot_versions`（version+1） |
| 班表 读整周 | `GET /partner/weeks/:weekStart` | `duty_weeks` + `duty_assignments` |
| 生成草稿 | `POST /partner/weeks/:weekStart/generate` | 写 `duty_assignments`（草稿态） |
| 换人/固定 | `PATCH /partner/assignments/:id` `{personId, locked, reason}` | `duty_assignments` + `duty_logs` |
| 校验 | `POST /partner/weeks/:weekStart/validate` | 读全部，写 `lastValidation` |
| 发布 | `POST /partner/weeks/:weekStart/publish` | `duty_weeks`（state/version）+ `duty_logs` |
| 撤回 | `POST /partner/weeks/:weekStart/withdraw` | 同上 + `withdrawalHistory` |
| 可排时间 读 | `GET /partner/availability?week=` | `duty_availability` |
| 可排时间 存（含代录） | `PUT /partner/availability` `{personId, week, picks[], reason}` | 同上 + `duty_logs` |
| 请假 申请/审批 | `POST /partner/leaves`、`POST /partner/leaves/:id/approve` | `duty_leaves` |
| 补位 | `POST /partner/leaves/:id/fill` `{personId, reason}` | `duty_leaves` + `duty_assignments`（version+1） |
| 考勤 读/录 | `GET/PUT /partner/attendance` | `duty_attendance` |
| 轮值统计 | `GET /partner/workload?weeks=4` | 聚合 `duty_assignments` |
| 记录 | `GET /partner/logs?week=` | `duty_logs` |

### 3.2 内容线

| 页面 | 接口 | 集合/表 |
|---|---|---|
| 我的稿件 / 版本 | `GET/POST/PUT /partner/works` | 新增 `work_drafts`（含 `versions[]`） |
| 审核列表/详情 | 复用 `GET /admin/submit`、`PUT /admin/submit/:id/approve` | 已有 `submit` |
| 留言审核 | 复用 `PUT /admin/message/:id/approve` | 已有 `message` |
| 歌曲排期 | 复用 `GET /admin/submit/songs` 等 | 已有 `submit` + `song_quota` |
| 站内公告 | 复用 `GET /user/notices` | 已有 `notice` |

### 3.3 身份线

| 页面 | 接口 | 集合/表 |
|---|---|---|
| 伙伴名册 | `GET /partner/roster` | 已有 `cadre` + `staff`（+ 资格字段） |
| 账号管理 | `GET/POST /admin/accounts`（超管） | 已有 `admin` |
| 我的 | `GET /partner/me` | `admin` + `cadre/staff` |

---

## 4. 集合设计（云开发文档库；若走 Express 则等价建表）

```js
duty_slot_versions {
  _id, version: 1, state: 'draft'|'published',
  templates: [{ day: 0..4, title: '早会', start: 410, end: 420,
                dept: '主持部', role: '主持', count: 1 }],
  publishedAt, publishedBy, reason
}

duty_weeks {
  _id, weekStart: '2026-10-26',            // 周一，北京时间
  state: 'none'|'draft'|'published'|'withdrawn',
  version: 0,                               // 发布版本号，撤回不复用
  baseVersion: 0,                           // 草稿基于哪个发布版
  lastValidation: { ok, issues[], at } | null,
  withdrawalHistory: [{ version, actor, at, reason, slots[] }],
  updatedAt
}

duty_assignments {
  _id, weekId, day: '2026-10-28', start: 730, end: 760,
  eventId: 'noon-2', eventTitle: '午间漫游',
  department: '播音部', role: '播音', seq: 1,   // 岗位序号，同格多部门靠它区分
  personId: 'gu' | null,
  locked: false,                                // 固定：再次生成保留
  why: '',                                      // 调整依据
  state: 'draft'|'published'
}

duty_availability {
  _id, weekId, personId,
  picks: [{ slotKey: '0-1', can: true }],       // 天序号-时段序号
  reason: '', source: 'self'|'proxy',           // 代录要留原因
  confirmedAt, confirmedBy
}

duty_leaves {
  _id, weekId, assignmentId, personId,
  start, end, reason, status: 'pending'|'approved'|'rejected',
  replacementPersonId: null, decidedBy, decidedAt
}

duty_attendance {
  _id, weekId, assignmentId, personId,
  state: 'present'|'leave'|'absent'|'',
  recordedBy, recordedAt
}

duty_rules { _id: 'global', maxWeek: 2, maxDay: 1, revision: 1, updatedBy }

duty_logs {
  _id, weekId, action: 'generate'|'assign'|'lock'|'publish'|'withdraw'|'leave'|'fill',
  actor, at, reason, before, after
}
```

> **推荐走云开发**（`cloud/` 云函数 + 集合）：符合「src 不动、只做加法」的铁律，也不需要备案域名。数据量很小（几十人 × 每周几十岗），文档库完全够用。
> 只有一种情况才走 Express：需要在电脑端后台做重聚合报表。此时 8 个集合对应 8 张表，`_id` 换 `id`，`picks` 拆 `duty_availability_slots` 子表。**二选一，不要两套并行写**。

---

## 5. 分阶段实施（每阶段都能单独验收）

### P0 身份与权限（0.5 周）

- `admin` 加 `dutyRoles[]` / `department`；`/partner/me` 返回资格
- `utils/request.js` 支持 `admin_token` 分键
- 落地页按 role 分流；站员访问伙伴端分包 → 拦回学生端
- **验收**：超管/社干各登录一次，看到的菜单不同；站员从学生端进不去

### P1 值班时段 + 可排时间（1 周，第一个可上线闭环）

- `slots` 页：周一到周五各自设时段（名称/起止/部门/人数），存草稿 → 发布（版本 +1）
- `availability` 页：站员按天看方块，点一下切「能来/不能来」，必填说明 → 提交
- 社干侧看到「10/13 已确认」，可代录（留原因）
- **验收**：超管发布 → 站员填 → 社干看到齐了。**这一步做完就能给社干试用**

### P2 生成 → 调整 → 发布（1.5 周，核心）

- 移植原型无权重引擎：先过滤硬条件（部门资格、该时段来不了、同场不兼两岗、每天上限、每周上限）→ 按本周场次少排序
- `planning` 页：生成草稿 / 再次生成（保留固定）/ 点人换人 / 固定 / 校验 / 发布 / 撤回
- 并发：发布用条件更新（`state='draft' && lastValidation.ok` 才写），撤回要校验「整周未开始 + 无业务关联」
- **验收**：缺岗时拦截发布；固定的人再次生成不动；撤回后站员看到「班表已撤回」

### P3 我的班表 + 请假 + 补位（1 周）

- `schedule/index`：站员看本人正式班表（只读），社干/超管看整周
- `leave`：站员从**真实岗位**发起请假（绑 assignmentId）；社干审批；批准后该岗变空缺、版本 +1
- `fill`：社干从空缺补位，走同一套校验
- **验收**：请假批准 → 班表那格让开 → 站员看到待补位

### P4 考勤 + 轮值 + 记录（0.5 周）

- `attendance`：五方块三态（到/假/缺），录完统计跟着变；站员只看不录
- `workload`：近 4 周场次与时长
- `history`：发布与调整记录（含撤回理由，只管理可见）
- **验收**：录考勤后轮值统计同步

### P5 内容线（1 周，可与 P2 并行）

- `work`：我的稿件列表 → 编辑（时长尺）→ 提交审核 → 版本记录
- `aifind`：AI 联网检索找稿（需 LLM 能力，云开发可调）
- 审核处理台复用一期已有
- **验收**：稿件提交 → 审核通过 → 版本记录可回看

---

## 6. 必须提前定的坑

| 坑 | 说明 |
|---|---|
| 周切点/时区 | 一律走 `src/services/bjTime.js` 的同一套规则；小程序端只传 `weekStart` 字符串，**不要在前端算周一** |
| 版本号 | 撤回后不能复用版本号：读 `version + publishedHistory + withdrawalHistory` 三者最大值 +1 |
| 同格多部门 | `assignment` 必须有 `department + seq`，否则「播音部 2 人 + 主持部 1 人」会被当成 3 个同岗 |
| 代录与本人 | 代录必须留原因并记 `source`，否则无法区分"本人填的"和"社干代填的" |
| 发布原子性 | 发布 = 写 assignments.state + weeks.version + logs 三处，必须同一事务 |
| 撤回边界 | 已开始的周、有请假/考勤关联的周禁止撤回（原型已实现这套判定，照搬） |
| 72 屏里的演示件 | 演示身份切换、假数据、`_at*.html` 快照一律不进代码 |

---

## 7. 与现有 6 页的关系

| 现有页 | 处置 |
|---|---|
| `login` | 保留，不动（已接 `/api/admin/login`） |
| `todo` | 保留为「登录后轻落地」，社干/超管都先到这里，再进 `desk` |
| `review` / `review-detail` | 保留，补「三类 × 四态」筛选（原型已定稿视觉） |
| `message` | 保留；后续可并入 `review`（同一队列），先不动 |
| `me` | 保留（v151 定稿），补「可排时间 / 考勤 / 请假 / 名册 / 互评」五个入口跳转 |

---

## 8. 一句话回答「怎么全部落实」

> 先把**身份**打通（已有登录，只差角色分流与岗位资格），再把**值班时段 + 可排时间**做成第一个真闭环（这一步就能上线试用），然后移植**无权重排班引擎**做生成/发布/撤回，接着补**请假/补位/考勤**，最后做**稿件与审核**。72 屏按角色去重后只需 21 个页面，其中 6 个已经有了。

---

## 9. 实施进度（2026-10-27 起）

### ✅ P0 身份与权限 —— 已完成

| 项 | 落地位置 | 说明 |
|---|---|---|
| 岗位资格 | `admin` 文档新增 `dutyRoles[]` / `department` | 走文档库无 schema，**不需要迁移脚本**；老账号读出来是空数组，`qualified=false` |
| 资格接口 | `GET /partner/me` | 返回 `isSuper / roleText / department / dutyRoles / qualified / abilities` |
| 自助维护 | `PUT /partner/me/duty` | 部门与岗位都走白名单，岗位自动去重 |
| 角色分流 | `pages-partner/todo` + `pages-partner/me` | 落地页按 `isSuper` 切文案与「只读」标记 |
| 站员拦截 | 伙伴端每页 `onLoad` 查 `admin_token` | 站员没有 admin 账号，本来进不来；分享链接直达时 reLaunch 到登录页 |

> ⚠️ **能力位一律后端给**（`abilities`），前端不自己从 `admin.role` 推。前端推错是越权入口，后端推错还有 `asSuperPartner` 兜底。

### ✅ P1 值班时段 + 可排时间 —— 已完成

| 页面 | 路径 | 角色 |
|---|---|---|
| 值班时段 | `pages-partner/schedule/slots/slots` | 超管可编辑发布；社干只读（同布局置灰） |
| 可排时间 | `pages-partner/availability/availability` | 全部伙伴可自填；社干可切换代录对象 |

**接口 12 条全部落地**（见 §3.1 更新后的表），集合建了 8 个（`lib/db.js` 的 `C` 里新增，`POST /system/init-collections` 会自动带上）。

实现中定下的四条口径，后续阶段不要推翻：

1. **时段用版本表**，不是「一条可覆盖的配置」。班表发布要把当时的时段钉死，否则改 10 月时段会让 9 月已发布班表历史失真。
   状态机：`无草稿 → draft → published`；下次存草稿 `version = 历史最大 + 1`。**空草稿允许存**（配置到一半退出是常态），**空草稿不能发布**。
2. **`slotKey = <day>-<seq>`，seq 只对某个时段版本有意义**。所以 `duty_availability` 存 picks 时一并记 `slotVersion`；读时版本不一致标 `stale:true` 让前端提示重填 —— **不静默丢弃站员填过的东西**。
3. **人员池 = `admin` 表 `status=1`，`personId = admin.id`**。`staff` 表是官网展示用（avatar/motto/sort），不代表有登录账号；混进来会产生「排了班但人永远填不了时间」的僵尸岗。
   将来要纳入 staff，只改 `handlers/partner/_kit.js` 的 `personKey / resolvePerson`，**不动接口签名**。
4. **代录与自填共用一条写入路径**，靠 `personId` 是否等于自己区分 `source`；代录必须留原因（≥2 字）并写 `duty_logs`。

**验证**：`node cloud/scripts/test-partner-duty.js` → 134 项断言（源码 + 打包产物各跑一遍，均全绿）。

### ⏭ 下一步

P2 生成 → 调整 → 发布。**开工前必须先定两件事**：
- 排班引擎的硬条件清单（部门资格 / 该时段来不了 / 同场不兼两岗 / 每天上限 / 每周上限）—— 原型里已有实现，需逐条对齐
- 发布原子性：云数据库**没有跨文档事务**，`assignments.state` + `weeks.version` + `logs` 三处写要么用 `runTransaction`（harness 已支持），要么设计成「先写 logs 再翻 state」的可重放顺序
