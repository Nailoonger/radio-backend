# 招新增量技术设计

基于本轮已授权的增量需求实现，复用云 API、Vue 管理端、小程序公开报名和现有测试 harness；不增加云集合或密钥。

## 数据结构

- `recruitment_batch.closedAt`：数值毫秒时间戳或 null；旧文档缺字段等同 null。保持原 `closesAt`，手动截止优先于未开始/开放状态。管理员和公开 DTO 输出 ISO 时间及 `windowState`，所有写入检查使用统一窗口状态。
<!-- review-fix: ISSUE-P1, ISSUE-P2 -->
- `interviewOrderIds`：按随机顺序保存的报名 ID 字符串数组，旧批次缺字段默认为空数组；`orderGeneratedAt` 存 UTC 毫秒数值或 null，对外输出 ISO 时间字符串或 null，旧批次缺字段等同 null。序号为数组下标 + 1。管理员批次 DTO 暴露 `orderGeneratedAt` 和非负整数 `interviewOrderCount`，管理员报名 DTO 及名单条目暴露 `interviewSequence`，公开查询 DTO 不返回序号或名单 ID。未生成时查看接口返回空 items、total 为 0、orderGeneratedAt 为 null；导出及空候选生成返回状态错误。
- `qqNumber`：去空格的 5～12 位数字字符串。新唯一占位采用 QQ 命名空间隔离原学号占位；历史 `studentNo` 原样保留，只通过管理员 `legacyStudentNo` 输出。原请求重试仅在原提交 key 已存在且 payload 一致时允许原学号字段。

## 接口与权限

| 接口 | 权限与参数 | 返回与错误 |
| --- | --- | --- |
| `POST /admin/recruitment/batches/:id/close` | 超管；`{version}` | 管理员 batch DTO；草稿/归档拒绝，重复截止幂等，版本冲突 `40910` |
| `POST /admin/recruitment/batches/:id/interview-order` | 超管；`{version,confirm?:'REGENERATE'}` | batch DTO；已有顺序必须确认；未截止、结果已发布或空候选拒绝 |
| `GET /admin/recruitment/batches/:id/interview-order` | 管理员；`page,pageSize` | `{batch,items,total,page,pageSize,orderGeneratedAt}`，最多 100 条/页 |
| `GET /admin/recruitment/batches/:id/interview-order/export` | 管理员 | `{filename,base64,mime}` Excel；HTTP 适配返回 Blob，未生成拒绝 |

items 包含 id/name/qqNumber/grade/className/interview/status/interviewSequence；不含查询凭证和内部备注。其余错误沿用现有参数、权限、关闭和状态错误。

## 模块与交互

1. 截止在单文档事务中检查批次版本并保存 `closedAt`，同步释放 `recruitment_control` 时间占位。报名、修改、撤回和重提交均同时写批次，数据库冲突或版本变化阻止截止前后竞态漏算。
2. 生成先按每页最多 100 条读取候选并以 `crypto.randomInt` 做 Fisher–Yates 洗牌；再在文档事务中核对批次版本及状态，将完整 ID 数组一次写入。每次报名审核/面试也更新批次版本，候选读取期间变化会拒绝生成。
3. 读取顺序按已存数组分页读取记录并附序号；导出遍历整份名单，读取最新面试信息并通过现有 ExcelJS 生成工作簿，使用既有云下载协议。
4. Vue 复用 SubmitList 的处理台布局语言，详情左侧资料/回答、右侧操作，各区滚动且窄屏单列；保留请求编号防止陈旧详情覆盖。另有名单查看弹窗与分页、生成确认、重新生成和导出。
5. 小程序字段、校验及提交缓存改为 QQ 号；旧重试缓存保留原请求供服务端安全恢复。手动截止优先显示，操作权限遵从服务端 `canEdit`，旧 QQ 缺失提示补填。

## 技术决策

| 决策 | 选择与理由 | 备选与取舍 |
| --- | --- | --- |
| 截止时间 | 新增 closedAt，保留计划时间与历史 | 直接改 closesAt 会丢失计划，提前于 opensAt 会破坏已有时间校验 |
| 顺序保存 | 单批次 ID 数组及版本校验，原子生成 | 每条报名逐个更新序号需要多文档事务和迁移，失败可能产生半份名单 |
| 名单变化 | 审核不自动重排，明确重生时更新 | 每次拟不录取自动重排会改变已经导出和安排的顺序 |
| 新标识 | 新 QQ 唯一占位命名空间 | 将旧学号视为 QQ 会产生错误联系方式和占位冲突 |

批次文档仍受云数据库大小限制；生成前检查保存体积并明确报错，超过限制不写半份顺序。本期不做分段名单集合。真实云事务、数据库权限和真机视觉仍需部署环境验收。

## 文件组织与需求对应

- F1、F7：`cloud/cloudfunctions/api/services/recruitmentForm.js`、`recruitment.js`；`miniprogram/pages/recruitment-form/index.*`、`recruitment-result/index.*`、`utils/recruitment.js`。
- F2、F4～F6：`cloud/cloudfunctions/api/services/recruitment.js`、`handlers/admin/recruitment.js`、`router.js`、`handlers/index.js`。
<!-- review-fix: ISSUE-P3 -->
- F2 公开展示：`miniprogram/pages/recruitment/index.js`，优先展示实际截止时间与手动截止状态文案。
- F3 及管理操作：`admin-web/src/views/Recruitment.vue`、`admin-web/src/api/recruitment.js`。
- 验收：`cloud/scripts/test-recruitment.js`、`test-recruitment-client.js`、`test-recruitment-admin.js`（真实 Vue 逻辑的权限、草稿及在途响应检查）、路由守门与 selfcheck；全量源码及打包回归、Vue build、小程序 WCC/WCSC 编译、既有 Jest。
