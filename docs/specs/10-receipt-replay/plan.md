# 点歌回执返回入口 Plan

## 架构概览
在现有原生小程序投稿页内完成：页面 JS 管理回执与个人周额度，WXML 渲染 SVG 图片和继续按钮，WXSS 沿用全局按钮与强调色。继续使用现有后端和云端接口，两种通道均返回相同的 `userWeekly`。对应 Spec F1～F5。

## 核心数据与接口
- `quotaWeekly`：`null | { limit: number, used: number, remaining: number | null }`。次数单位为次；`limit`、`used` 是非负整数，有限次数的 `remaining` 是 0～limit 的整数；`limit === 0` 表示不限，不要求响应提供 `remaining`，保存时统一为 `null`。缺失必要字段或非法数据为未知额度。
- `receipt.canReplay`：布尔值，新回执默认为 `false`。只有提交成功之后的新额度响应有效且 `limit === 0 || remaining > 0` 才变为 `true`。
- `receipt.leftText`：新回执为空串；有限次数的新额度有效且剩余大于 0 时由服务端 `remaining` 生成，用完时与预览屏 B 一致不再提示剩余，不解析文案也不减 1。
- `loadQuota()`：调用 `GET /user/submit/quota`；校验并保存 `userWeekly`，更新表单额度提示和当前回执。返回有效额度或 `null`；失败静默，不影响提交成功回执。
- `resetSongForm()`：清 `receipt/songName/singer/wishContent/wantBroadcastTime/slotLabel`，取消 `slotDays[].items[].selected`，关闭时段弹层，恢复 `allowReschedule: true`。保留文稿字段，不主动请求接口。
- `replaySong()`：仅当前回执允许继续时执行；回到 `type: 1`，调用重置、`prepareSong()`，滚动到顶部。

## 模块设计与交互
1. **额度与回执（F2、F5）**：每次 `loadQuota()` 使用递增请求序号，并捕获当前页面生命周期版本和账号 token；响应不再属于最新请求、生命周期或账号时丢弃。`showReceipt()` 立即显示成功回执，清掉提交前额度，启动新的额度请求，旧响应无法决定按钮。
2. **继续和返回（F3、F4）**：`onShow()` 仅在存在回执时调用重置并滚动到顶部，再按现有流程刷新登录态、开关和点歌前置数据。普通草稿不清。`onHide/onUnload` 更新生命周期版本并使在途额度失效。提交请求记录生命周期版本和点歌字段快照；离页之后才成功时，仅当前点歌字段仍与提交快照全部相同时清理已提交表单。任一字段已编辑则保留整份新草稿，两种情形均不显示旧回执；如果用户已返回，再刷新点歌前置数据。
3. **回执界面（F1、F5）**：圆底内使用 52rpx SVG 勾，路径和预览一致。采用[官方 WeUI 同类组件](https://github.com/wechat-miniprogram/weui-miniprogram/blob/master/src/components/icon/icon.ts)使用的 SVG Base64 图片方式，源 SVG 保存在 assets 方便维护。回执按钮容器纵向间距 20rpx，「再点一首」使用白底、强调色描边，在「查看我的投稿」上方，仅按 `receipt.canReplay` 渲染。
4. **验证**：通过 Node VM 捕获 Page，mock 微信 API 和请求，在真实页面方法上测试服务端额度、重置、导航与 Promise 返回顺序。运行现有点歌验证、全量 JS 语法检查、WXML 样式检查和 Jest。

## 文件组织
- `miniprogram/pages/submit/submit.js`：结构化额度、回执更新、继续按钮方法和生命周期保护。
- `miniprogram/pages/submit/submit.wxml`：SVG 图片和条件继续按钮。
- `miniprogram/pages/submit/submit.wxss`：SVG 尺寸、回执按钮间距和浅色场景描边。
- `miniprogram/assets/receipt-check.svg`：与批准预览一致的图标源文件。
- `scripts/verify-receipt-replay.js`：独立的前端行为回归，无数据库或外网依赖。
- `docs/specs/10-receipt-replay/{spec,plan}.md`：已批准方案、实现计划及验收记录。

## 技术决策
| 决策 | 选择与理由 | 未采用的方案 |
|---|---|---|
| 剩余次数 | 成功后刷新服务端额度，覆盖多端提交和配置变化 | 解析提示文案、本地减 1 会过期 |
| 慢请求 | 请求序号 + 页面版本 + token 比较，沿用现有方法即可 | 引入全局状态库或新缓存增加复杂度 |
| SVG | 内嵌 SVG 图片，离线可用，圆角几何与预览一致 | 文字符号依赖字体；PNG 不满足用户要求 |
| 重置范围 | 只清成功点歌，保留未提交草稿 | 每次进入投稿页无条件清空会丢草稿 |
| 验证方式 | 独立 Node 脚本，无需初始化后端测试数据库 | 把页面回归加入后端 Jest 会增加无关数据库初始化 |

## 已有约束
撤销后的次数仍以服务端为准，本次不修改其计数规则。回执审核/排期说明沿用现有行为；本次不扩展排期业务。

## 审查与验收记录（2026-10-01）
- Spec 独立单轮审查：无 critical，1 项 major（额度有效性）已补充条件和对应验收；Plan 独立单轮审查：无 critical/major。
- 代码独立审查发现「旧提交迟到会清除返回后新草稿」，已改为提交字段快照匹配后才清理，并增加异步回归。
- `node scripts/verify-receipt-replay.js`：37/37 通过，覆盖 AC2～AC8 的额度、失败、重置、草稿、导航和慢请求行为。
- `node scripts/verify-song-submit.js`：107 项通过；现有点歌后端规则保持。
- 小程序所有 JS 的 `node --check`、`node scripts/check-wxml-classes.js`、本次文件 `git diff --check`：通过。
- SVG XML 解析、圆角属性、WXML 内嵌内容与源文件一致性：通过，支持 AC1 的资源和结构验收。
- `npx jest --runInBand`：41 通过、15 失败，失败集中在已废弃的 member 接口及关联 switch 用例；本次仅修改小程序和独立验证脚本，没有修改这些后端文件。
- 微信开发者工具编译和真机视觉验收未执行；当前证据为页面方法的自动验证、WXML 静态检查及 SVG 资源验证。
