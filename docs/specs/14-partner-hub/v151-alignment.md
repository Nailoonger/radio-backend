# 伙伴端三角色对齐 v151 方案

> 基准：`partner-hub/app.html`（v151 定稿，线上 `https://jingyou-partner-hub.app.workbuddy.host/app.html`）
> 本文只做一件事：**把 69 屏按三个角色摊开，逐屏指明落到哪个小程序页面、当前差什么**。
> 视觉参数以原型为唯一事实源；原型里的演示件（身份切换器、假数据、快照页）一律不进代码。

---

## 0. 上一版为什么被否

`partner-hub/desk-preview-v1.html` 只做了**社干/超管的工作台**，且是按我的理解重排的版式 —— 两个错：

1. **漏了站员** —— 站员是三个角色里屏数最少但入口完全不同的一端（4 个 tab，不是 5 个）。
2. **不是 v151 原样** —— 区块划分、模块卡内容、角标口径都是我自己起的，没有逐屏照抄。

正确做法：**三个角色各自照 v151 的屏落地，一个页面用 `role` 状态表达多个角色版本**。

---

## 1. 三角色屏数（精确统计，非估算）

| 角色 | 屏数 | 底部 tab（v151 定稿） |
|---|---|---|
| 站员 member | **12** | 工作台 · 稿件 · 班表 · 我的（**4 个**） |
| 社干 manager | **26** | 工作台 · 审核 · 稿件 · 班表 · 我的（**5 个**） |
| 超管 super | **31** | 同上 5 个 |
| **合计** | **69** | |

角色档案（v151 写死，落地时改为后端返回）：

| 角色 | 名称 | 部门 · 岗位 | 编号 |
|---|---|---|---|
| 站员 | 周牧之 | 播音部 · 主持 | JY-2407 · 2024 级 |
| 社干 | 陈屿 | 主持部 · 主班 | JY-G-04 · 2023 级 |
| 超管 | 顾青 | 广播站 · 超级管理员 | JY-A-01 |

> ⚠️ 超管 = 社干全部功能 + 账号 / 排班规则 / 考勤总览。原型里超管那 16 屏是**社干屏的复制**，
> 落地时不是复制代码，而是同一页面按 `role` 分支渲染。

---

## 2. 屏 → 落地页面（21 页，一页吃多屏）

### 站员 12 屏 → 6 页

| 屏 id | 名称 | 落地页 | 状态 |
|---|---|---|---|
| `home` | 工作台 | `pages-partner/desk/desk`（新，吃 home+desk） | ❌ 未建 |
| `me` | 我的 | `pages-partner/me/me` | ✅ 已对齐 v151 |
| `people` | 可排时间填报 | `pages-partner/availability/availability` | ⚠️ 已建，视觉待对齐 |
| `schedule` | 我的班表 | `pages-partner/schedule/index`（新） | ❌ 未建 |
| `leave` | 请假申请 | `pages-partner/leave/leave`（新） | ❌ 未建 |
| `my-att` | 我的考勤 | `pages-partner/attendance/attendance`（新，只读态） | ❌ 未建 |
| `feedback` | 互评 | `pages-partner/feedback/feedback`（新） | ❌ 未建 |
| `notices` | 站内公告 | 复用学生端 `pages/notices/notices` | ⚠️ 待确认 |
| `my-drafts` | 稿件 | `pages-partner/work/work`（新） | ❌ 未建 |
| `versions` | 版本记录 | 同上（状态分支） | ❌ 未建 |
| `editor` | 写稿 · 时长尺 | 同上（编辑态） | ❌ 未建 |
| `aifind` | 找稿 · AI 检索 | 同上（找稿态） | ❌ 未建 |

### 社干 26 屏 / 超管 31 屏 → 共用这些页

| 屏 id | 名称 | 落地页 | 状态 |
|---|---|---|---|
| `desk` | 工作台 | `pages-partner/desk/desk`（新） | ❌ 未建（todo 页是旧样式） |
| `submissions` / `submission-detail` | 审核 / 处理台 | `pages-partner/review/review` + `review-detail/detail` | ⚠️ 已建（一期），待补「三类 × 四态」筛选 |
| `messages` / `song-schedule` | 留言审核 / 歌曲排期 | `pages-partner/message/message` 等 | ⚠️ 已建（一期） |
| `planning` / `draft` / `slots-pub` | 排班工作台 / 草稿 / 时段发布 | `pages-partner/schedule/planning`（新） | ❌ 未建（P2） |
| `slots-pub` / `timeslots` | 值班时段 | `pages-partner/schedule/slots/slots` | ⚠️ 已建（P1），视觉待对齐 |
| `scheduling` / `mgr-schedule` | 班表管理 | `pages-partner/schedule/index`（新） | ❌ 未建 |
| `workload` / `history` | 轮值 / 记录 | `pages-partner/schedule/workload`、`history`（新） | ❌ 未建 |
| `attendance` / `att-overview` | 考勤录入 / 总览 | `pages-partner/attendance/attendance`（新） | ❌ 未建 |
| `leave-approve` / `fill` | 请假审批 / 岗位补位 | `pages-partner/leave/leave`（审批态） | ❌ 未建 |
| `roster` | 伙伴名册 | `pages-partner/roster/roster`（新） | ❌ 未建 |
| `accounts` / `acc-issue` / `acc-reset` | 账号（超管） | `pages-partner/accounts/accounts`（新） | ❌ 未建 |
| `rules` | 排班规则（超管） | `pages-partner/schedule/rules`（新） | ❌ 未建 |
| `proxy` | 值班时间代录 | `pages-partner/availability/availability`（代录态） | ⚠️ 已建（P1） |

**不做（明确划到电脑端）**：模块开关、系统设置、数据看板、批量导出 —— 原型超管区底部已写明。

---

## 3. 通用视觉基准（从 v151 逐条量出，不许自己起）

| 部件 | 参数 |
|---|---|
| 欢迎带 `.wel` | 通栏 `margin:-14px -18px 0`、padding `20/18/48`、右侧园林线稿 282px `opacity:.27` + `multiply` + 双向 mask |
| 大白卡 `.bigc` | 圆角 20px、padding 18px、`.float` 投影 `0 6px 14px -6px rgba(15,28,46,.08), 0 22px 44px -18px rgba(15,28,46,.16)`；`.carousel{margin-top:-24px}` 压接欢迎带 |
| 模块卡 `.mod` | 白卡 圆角 17px、`1px #E7E9EE`、padding 12px、min-height 100px；`.mods` 2 列 gap 10px |
| 模块卡文字 | 标题 14px/550；说明 11px muted；左下数字 25px（**>0 变 `--accent`，0 为灰**）+ 单位 10px；右下箭头 18px `#999DA6` |
| 胶囊 / 卡片圆角 | 单行元素 9999px；内容卡 17–20px |
| 颜色 | `--accent #0066CC` 唯一强调色；站徽双色 `#2497D5` / `#093592`；**任何形式都不深色** |
| 角标 | 唯一事实源 `TODO`；同一件事只归一处、归零即隐、>99 显示 `99+` |

---

## 4. 落地顺序（按页面横向推进，一次覆盖三角色）

| 批次 | 页面 | 对齐的 v151 屏 | 说明 |
|---|---|---|---|
| **① 视觉锚定** | `me`（已对）、`login`（已对）、`desk`（站员 `home` + 社干/超管 `desk`）、`availability`（`people`/`proxy`） | 4 屏 | 先把"三角色同一页、按 role 分支"的模式立住 |
| **② 审核线** | `review` / `review-detail` / `message` | `submissions` `submission-detail` `messages` `song-schedule` | 一期页面补「三类 × 四态」与角色分支 |
| **③ 排班线** | `schedule/index`、`schedule/planning`、`schedule/rules`、`workload`、`history` | `scheduling` `planning` `draft` `rules` `workload` `history` | P2 核心，含无权重引擎 |
| **④ 事务线** | `leave`、`attendance`、`feedback`、`roster` | `leave` `leave-approve` `fill` `attendance` `att-overview` `feedback` `roster` | P3–P4 |
| **⑤ 内容线** | `work`、`accounts` | `my-drafts` `editor` `versions` `aifind` `accounts` `acc-issue` `acc-reset` | P5，可与 ③ 并行 |

---

## 5. 三条硬规矩

1. **每页先出静态预览，标注版本号，陛下点头才写业务代码。**
2. **一页多态**：站员 / 社干 / 超管的差异用 `role` 状态分支，不复制三份页面。
3. **演示件不进代码**：原型里的身份切换器、假数据、快照页只留在原型，落地时数据一律来自 `/partner/*` 与 `/admin/*` 真实接口。
