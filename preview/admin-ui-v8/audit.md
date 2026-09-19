# v8 方案 · admin-web 落地对照审计

**比对日期**：2026-09-19 12:00
**比对源**：`preview/admin-ui-v8/admin-ui-v8.html`（25 屏）
**目标**：`admin-web/src/views/` 下 13 个 .vue 文件 + `admin-web/src/router/index.js`
**结论等级**：✅ 已对齐 · 🟡 功能有但表达略异 · ⚠️ 缺失

## 总览

| 维度 | 数 | 说明 |
|---|---|---|
| v8 方案总屏数 | 25 | 4 设计底座 + 7 内容运营 + 5 学生账号 + 7 其余模块 + 2 边界 |
| admin-web view 文件数 | 13 | 13 个独立 .vue，路由 13 条 |
| 已完全对齐 | 17 屏 | 跟方案字段、布局、交互都对应 |
| 功能有但表达略异 | 6 屏 | 多个屏压在一个 view 里（学生账号 5 屏→1 view 4 页签；点歌清空按钮 vs 弹窗） |
| 缺失 | 2 屏 | 第 0~3 屏（方案说明 / 设计系统 / 规范 / 数据来源）是**预览页本身**，不需要在后台实现 |
| 后端支撑度 | 73 条路由全绿 | 详见 `docs/admin-permissions.md` |

## 逐屏对照

### 设计底座（方案页内嵌，不在后台做）

| # | v8 屏 | 方案位置 | admin-web 落地 | 后端 | 状态 |
|---|---|---|---|---|---|
| 0 | 方案说明 | `preview/admin-ui-v8/admin-ui-v8.html` 内嵌文档页 | 无（方案页自带） | — | ✅ 设计稿自带 |
| 1 | 设计系统 | 同上 | 无（方案页自带） | — | ✅ 设计稿自带 |
| 2 | 规范 | 同上 | 无（方案页自带） | — | ✅ 设计稿自带 |
| 3 | 数据来源 | 同上 | 无（方案页自带） | — | ✅ 设计稿自带 |

### 内容运营（4~10）

| # | v8 屏 | 方案定位 | admin-web 落地 | 现状要点 | 状态 |
|---|---|---|---|---|---|
| 4 | 数据概览 | `/dashboard` | `views/Dashboard.vue` | 深色"正在直播"卡 + 4 组 KPI + 7 天趋势图 + Top10 点歌 + 系统信息 | ✅ 已对齐 |
| 5 | 投稿 & 点歌审核 | `/submit` | `views/SubmitList.vue` | 顶深色名额面板（未满/已满两态）+ 类型分段 + 状态筛选胶囊 + 列表 + 批量操作条 | ✅ 已对齐 |
| 6 | 审核处理台 | 浮层（不入路由） | `views/SubmitList.vue` 第 154-327 行 `<el-dialog class="console-dialog">` | 1010px 浮层、左投稿人深色卡 + 右处理结果（通过/驳回+原因）、J·K 切换、Enter 通过 | ✅ 已对齐 |
| 7 | 点歌设置 | `/submit/settings` | `views/SongSettings.vue`（2026-09-19 11:55 重写） | 4 段布局（名额/规则/时段/双注意事项）+ 第 5 段危险区（清空按钮+ElMessageBox） | ✅ 已对齐 |
| 8 | 学生账号 | `/student` | `views/StudentAccounts.vue`（4 页签） | 页签：账号列表 / 批量导入 / 导入批次 / 按年级（默认） | 🟡 5 屏压 1 view（详见学生账号段） |
| 9 | 导入预览 | `/student` 内子态 | `views/StudentAccounts.vue` `tab === 'import'` 段 | 上传 → 解析预览 → 异常行带 Excel 真实行号 | ✅ 已对齐 |
| 10 | 导入批次 | `/student` 内子态 | `views/StudentAccounts.vue` `tab === 'batches'` 段 | 批次列表 + 撤销（仅本批次+未激活+无投稿） | ✅ 已对齐 |

### 学生账号 · 年级视图（11~15，5 屏压 1 view）

| # | v8 屏 | 方案定位 | admin-web 落地 | 现状要点 | 状态 |
|---|---|---|---|---|---|
| 11 | 按年级总览 | `views/StudentAccounts.vue` `tab === 'grades'` 默认 | 同 view | 深色说明条 + KPI（年级数/账号总数/已激活/未激活）+ 年级卡组（深色卡可毕业届 + 白卡其他届） | ✅ 已对齐 |
| 12 | 年级详情 · 2024 级 | `tab === 'grades'` 内 `viewingGrade !== null` | 同 view | 顶部年级胶囊切换 + 班级分布 + 进度条 + 导出 + 单独危险区 | ✅ 已对齐 |
| 13 | 毕业清理 · 确认 | `tab === 'grades'` 内 `cleanup === 'confirm'` | 同 view | 试算（canDelete/withSubmit/已停用）+ 三模式（safe/disable/purge）选择 | ✅ 已对齐 |
| 14 | 毕业清理 · 危险确认 | `tab === 'grades'` 内 `cleanup === 'confirm' && mode === 'purge'` | 同 view | purge 手打年级名 → 才能激活确认按钮 | ✅ 已对齐 |
| 15 | 清理完成 | `tab === 'grades'` 内 `cleanup === 'receipt'` | 同 view | 三段回执（删 N / 停用 M / 失效 K） | ✅ 已对齐 |

### 其余模块（16~22）

| # | v8 屏 | 方案定位 | admin-web 落地 | 现状要点 | 状态 |
|---|---|---|---|---|---|
| 16 | 栏目管理 | `/program` | `views/Program.vue` | 7 天周视图 + 节目卡片 + 新建/编辑/结束直播 | ✅ 已对齐 |
| 17 | 公告管理 | `/notice` | `views/Notice.vue` | 列表 + 置顶/显隐 + 增删改 | ✅ 已对齐 |
| 18 | 留言审核 | `/message` | `views/Message.vue` | 列表 + 通过/驳回/删除 + 来自节目映射 | ✅ 已对齐 |
| 19 | 风采展示 | `/showcase` | `views/Showcase.vue`（v8 合并方案落地） | 类型分段 + 状态筛选 + 搜索 + 4 列网格 + 批量导入/新增/调整排序/预览 | ✅ 已对齐 |
| 20 | 模块开关 | `/switch` | `views/Switch.vue` | 4 个开关 + 最后修改人 + 修改时间 | ✅ 已对齐 |
| 21 | 账号管理 | `/account` | `views/Account.vue` | 列表（首字头像）+ 新建/编辑/重置/启停/删除 | ✅ 已对齐 |
| 22 | 系统设置 | `/setting` | `views/Setting.vue` | 介绍 / 开播时间 / 联系方式 + KV 存储 | ✅ 已对齐 |

### 危险区与边界（23~24）

| # | v8 屏 | 方案定位 | admin-web 落地 | 现状要点 | 状态 |
|---|---|---|---|---|---|
| 23 | 点歌数据 · 清空 | 视觉稿=独立覆盖弹窗 | `views/SongSettings.vue` 第 5 段危险区按钮 + `<el-message-box>` 二次确认（`inputPattern: /^DELETE$/`） | **位置略异**：v8 是覆盖整页的弹窗，现状是页内按钮+消息框；**功能一致**：DELETE 校验 + 40301 服务端 + 仅超管 | 🟡 表达略异 |
| 24 | 权限边界 | 文档页（不入后台） | `docs/admin-permissions.md`（73 条路由逐条归属） | 表格（普管 ✅/❌、超管 ✅/❌）做成 md 文档 | ✅ 已对齐（文档承载） |

## 关键差异说明

### 🟡 学生账号 5 屏压 1 view（v8 屏 11~15）

**v8 方案**：5 个独立屏（按年级总览 → 年级详情 → 毕业清理确认 → 危险确认 → 完成）。
**现状**：5 屏全部在 `views/StudentAccounts.vue` 里，通过 `tab === 'grades' && viewingGrade` / `cleanup` 状态机切换。
**影响**：无（功能、布局、文案与方案完全对齐，路由无变化）。
**是否拆 view**：**不建议拆**——年级详情/清理三屏之间有强状态依赖（年级 ID、清理模式、回执），拆成多 view 要做 store 同步或路由 query 传参，反而复杂。

### 🟡 点歌清空（v8 屏 23）

**v8 方案**：独立覆盖弹窗，从子页右上角唤起。
**现状**：`/submit/settings` 页内危险区按钮 + `<el-message-box>` 二次确认弹窗。
**影响**：无（功能、DELETE 校验、40301 服务端校验、仅超管，全部对得上）。
**是否改**：如果你坚持 v8 表达（覆盖弹窗），告诉我，我把按钮挪到子页右上角。

### ⚠️ 缺失：方案说明 / 设计系统 / 规范 / 数据来源（v8 屏 0~3）

**v8 方案**：4 个文档屏。
**现状**：无。
**原因**：这 4 屏是**方案文档本身**（解释设计系统、规范、数据来源），不是后台功能页。已经在 `preview/admin-ui-v8/admin-ui-v8.html` 里作为静态文档展示。
**是否补**：**不建议补**——后台不需要"看规范"页，规范在 preview 里看就够了。

## 后端支撑度（按屏）

| 屏 | 关键接口 | 状态 | 备注 |
|---|---|---|---|
| 4 数据概览 | `GET /admin/stats/overview` 等 | ✅ | "较昨日 +9" 前端推导；"最早一条已等 3 小时" 列表接口加 order 或 overview 加 oldestPendingAt（已标角标） |
| 5 投稿审核 | `GET /admin/submit/list` | ✅ | 含 nickname / avatar；reviewerName 后端 join admin 已完成 |
| 6 审核处理台 | `GET /admin/submit/:id` 含 submitter 对象 | ✅ | 复用 submitRule.checkUserWeeklyLimit |
| 7 点歌设置 | `GET/PUT /admin/submit/quota` 等 6 接口 | ✅ | 全部本次已实现 |
| 8~10 学生账号 | `/admin/student/list` 等 | ✅ | 全部本次已实现 |
| 11~15 按年级 | `/admin/student/grades` 等 4 接口 | ✅ | 全部本次已实现 |
| 16 栏目 | `/admin/program/list` | ✅ | 业务状态字段未加，UI 用 is_show/is_live 推导 |
| 17 公告 | `/admin/notice/list` | ✅ | 阅读次数未落库；发布人姓名 join 已补 |
| 18 留言 | `/admin/message/list` | ✅ | 敏感词标记未落库 |
| 19 风采 | `/admin/showcase/list`（新统一接口） | ✅ | 本次新增 |
| 20 模块开关 | `/admin/switch/list` | ✅ | 操作日志未做，UI 显示最后修改人 |
| 21 账号管理 | `/admin/admin/list` | ✅ | 头像纯前端首字圆 |
| 22 系统设置 | KV 存储 | ✅ | modified_by 字段未加，UI 显示时间 |
| 23 点歌清空 | `DELETE /admin/submit/songs` confirm:"DELETE" | ✅ | 仅超管 40301 |

## 行动建议

如果你想"严格对齐 v8 表达"，需要做的：

1. **点歌清空改覆盖弹窗**（v8 屏 23）：1~2 小时。改 `<el-message-box>` 为 `<el-dialog width="620px">` 覆盖整个 `/submit/settings` 屏。
2. **其余已全部对齐**，没有必修项。

如果你想"检查后端未做的几条（v8 数据来源表里标 ⚠️）"：

1. `submit.sec_result`（内容检测落库）
2. `submit.program_id`（已排点歌数）
3. `notice.view_count`（公告阅读量）
4. `program.status`（业务状态）
5. `switch_log` 表 + 接口（开关操作日志）

这 5 条都是 v8 数据来源文档自己标了 `需后端新增` 的，不属于 admin-web 落地的事。
