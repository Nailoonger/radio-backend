# 招新增量实现与验证

日期：2026-10-03（北京时间）。本期代码已完成，保留用户原有工作区改动，未提交或操作生产云环境。

## 已实现

- 固定必填姓名、QQ 号、年级、班级；QQ 5～12 位数字字符串，按批次唯一；历史学号与旧查询码兼容。
- 超管立即截止，保存原计划时间和报名，关闭全部公开写操作并开放审核；不能重新开放。
- 居中双栏审核处理台、完整回答、上一条/下一条、未保存修改确认，面试及审核草稿互相保留，陈旧或关闭后的响应不覆盖当前详情。
- 超管随机生成和保存完整面试顺序，排除撤回/拟不录取；重新生成须确认。所有管理员可分页查看和导出完整 XLSX。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| 云回归（源码 + 单文件发布产物） | 3699 项，失败 0 项 |
| 招新云业务 | 每轮 232 项，含 1106 名候选完整生成、稳定序号、全量 XLSX 解析、截止/权限/版本冲突/容量拒绝及历史兼容 |
| 小程序业务 | 34 项，含 QQ 校验、旧暂存恢复、旧 QQ 缺失、提前截止展示 |
| 管理端业务 | 53 项，执行真实 Vue script setup 与 API 门面，含角色、确认、草稿保留、请求竞态及下载合同 |
| Vue 构建与模板绑定 | 构建通过，模板未声明引用为 0 |
| 小程序 | 3 页 WXML/WXSS 使用已安装 WCC/WCSC 编译通过，全量 30 份 JS 语法检查通过 |
| 代码与路由 | 语法及 git diff --check 通过；108 条管理路由就绪、权限矩阵检查通过 |
| 原 Express Jest | 6 套件：41 通过、15 失败；旧 member/switch 问题，与前一版相同，本期未改 Express 源码和旧测试 |

管理端回归已纳入 `cloud/scripts/regression.js` 的源码轮，自动发布流程会执行。新增测试统一输出回归脚本要求的结论行。

## 验收对应

- AC1、AC2、AC4～AC8 的接口及流程行为由业务回归覆盖。版本冲突使用内存 harness 故障注入验证，无半份顺序或部分导出文件。
- AC3 的弹窗结构、导航、保存和关闭行为已编译及行为验证。浏览器预览工具初始化时报「系统找不到指定的路径」，未完成截图及真实窄屏视觉验收。
- 独立只读复查另验证了跨 105 个已手动截止批次的 current 查询、205 条跨页顺序/导出、QQ 前导零、历史原码恢复、名单缺失时明确拒绝；未发现新增可复现缺陷。

真实云数据库事务冲突、索引、容量限制与真机展示仍需部署环境实测；内存回归不能替代这些检查。

## 提交与更新

沿用既有自动发布工作流。push 到 master 后更新云 API 和 Web 静态托管；小程序代码仍需通过微信开发者工具编译、上传与发布。复用已有 6 个招新集合和密钥，本期无需重新初始化或迁移数据。

仅提交本期相关路径，避免把已有 `.workbuddy`、preview 和 shots 改动一起提交：

```powershell
Set-Location C:\Users\Administrator\radio-backend
git add -- admin-web/src/api/recruitment.js admin-web/src/views/Recruitment.vue cloud
git add -- miniprogram/pages/recruitment miniprogram/pages/recruitment-form miniprogram/pages/recruitment-result miniprogram/utils/recruitment.js docs/recruitment.md docs/admin-permissions.md docs/specs/13-recruitment-review
git commit -m "feat(recruitment): 完善截止审核与面试名单"
git push origin master
```
