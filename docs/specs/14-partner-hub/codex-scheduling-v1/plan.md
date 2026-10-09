# 菁悠伙伴端·均衡轮值排班实施草案·Codex v1

> 日期：2026-10-07。依据同目录 spec.md；具体规格与原型待用户查看，本文件供一起审阅，不授权本轮修改业务代码。

## 架构与边界

正式实现落在 cloud API，依赖 codex-v1 的 partnerAuth、partnerShift、partnerLeave 与独立伙伴 token；不调用学生歌曲 scheduling 服务。取消旧总体规格的每人 weight，生成请求白名单遇 weight／priority 字段返回 40001，不读取已有个人权重。原始历史保留。

界面调用排班服务，排班服务从规则、人员资格、可用时间、发布周与历史快照构造输入，交纯函数生成器，再以事务保存草稿。生成器不读写数据库。发布与补位复用 partnerShift 的 revision、发布基线和 person-day 锁，不能直接写 publishedSlots 绕过闭环。

## 数据与接口

<!-- review-fix: SCHED-PLAN-01 -->
在既有八个伙伴集合外新增三个 ADMINONLY 集合：`partner_shift_rules`（单文档：revision、templates、maxWeek、maxDay、updatedBy、updatedAt、audit）；`partner_availability`（固定 ID `<staffId>:<week>`：submitted、unavailable[{date,startMin,endMin,reason}]、revision、updatedBy、代录理由）。`partner_qualification`（固定 ID staffId：roles 非空白名单、qualificationRevision、updatedBy、updatedAt、audit）。部门来自 staff 当前记录，不能由客户端传入；生成依赖保存源 staff 的部门／启用状态摘要，读取与资格文档均在发布事务内。资格文档缺失视为未具资格，超管建立或修改后递增资格版本。限制周最多 100 岗位、人员 100，规则、资格修改和禁排数据均留审计。

<!-- review-fix: SCHED-PLAN-04 -->
partner_shift_week 追加 draftInputDigest、draftDependencies（ruleRevision、各人员资格／状态版本、availabilityRevision、源 staff 摘要、受影响周 publishedVersion、historyRevision、各岗位 rotationRevision）、draftGeneration（algorithmVersion、steps、bounded、why）、draftAudit 与 slot.fixed。发布快照保留场次 eventId、岗位 slotId、role、personId 与开始时责任人；历史统计以生成时服务端北京时间为锚点，取该时刻本周一零点之前 4 个完整北京时间周（左闭右开）的已结束且未取消场次，eventId+staffId 去重，并只计开始时最后有效 activeStaffId。请假批准后的原人员不计，替补计入；撤销或事实更正按新审计记录重新派生，不由客户端改计数。规则文档另存 historyRevision 及 rotationByRole（按 department+role 固定键存 head/rotationRevision）；涉及该历史窗口的事实更正原子递增 historyRevision，使引用旧历史的草稿过期。生成保留 windowStart/windowEnd、snapshotAt、每人统计数值及引用不可变责任记录的摘要。轮转改变也使引用旧 rotationRevision 的草稿过期；跨周旧草稿保留原统计窗口，明确重新生成后采用新窗口。发布推进轮转、发布周、通知及幂等回执在同一事务内，仅推进本次涉及的岗位键，回执命中不重复推进。

| 接口 | 权限、输入与输出 |
|---|---|
| GET /partner/qualifications?cursor=&limit= | manager，返回 staffId/name/department/roles/qualificationRevision，最多 30 条。 |
| PUT /partner/qualifications/:staffId | super，{roles,expectedRevision,reason,requestId}；校验现有人员，返回资格及新版本，不接受客户端 department。 |
| GET /partner/shift-rules | manager 可见规则值；不含个人参数。 |
| PUT /partner/shift-rules | super，{expectedRevision,templates,maxWeek,maxDay,reason,requestId}；返回新 revision，规则范围严格验证。 |
| GET /partner/availability?week= | member 只返回本人；manager 返回候选覆盖与版本，理由仅具管理权限者可见。 |
| PUT /partner/availability/:week | 本人，{expectedRevision,unavailable,requestId}；manager 代录增加 staffId、reason；submitted=true。 |
| POST /partner/schedule/:week/generate | manager，{expectedRevision,expectedPublishedVersion,expectedRuleRevision,requestId}；读新快照，保留 fixed，返回草稿、缺岗、解释、digest、revision 与 bounded。当前已发布安排默认 fixed；开始过的场次不可解固定。 |
| GET /partner/schedule/:week/candidates?slotId= | manager，返回 eligible/reasons/weekCount/historyCount/historyMinutes；排除当前岗位自身后校验。 |
| POST /partner/schedule/:week/change | manager，{slotId,staffId,expectedRevision,reason,requestId}；同校验器，修改并固定该岗位，追加审计。 |
| POST /partner/schedule/:week/fixed | manager，{slotId,fixed,expectedRevision,reason,requestId}；取消固定也留原因。 |
<!-- review-fix: SCHED-PLAN-03 -->
| POST /partner/schedule/:week/validate | manager，{expectedRevision}；服务端事务读取最新依赖并校验完整草稿。通过时原子写 draftDependencies/draftInputDigest、清 stale、递增 revision，返回 {valid:true,revision,inputDigest}；失败返回 {valid:false,issues,revision}，不写草稿或依赖，保留过期状态。发布只消费服务端确认后的依赖，客户端不能传 digest 覆盖。 |
| POST /partner/schedule/:week/publish | 复用既有接口，另验证 draftInputDigest 与依赖版本；未填满、硬冲突、变化返回40910／40911，成功创建发布版本。 |

既有 /partner/schedule/:week/rebase 复制最新发布周，设置所有原发布岗位 fixed；社干明确解固定后才可改人。既有请假 decision、replacement、correction 保持原闭环，候选排序增加同一均衡比较器。补位不会整体再生成。任何批准／补位修改发布状态后使旧 draftStale=true。

## 生成逻辑

<!-- review-fix: SCHED-PLAN-02 -->
1. 校验输入周、时段、人数、岗位资格与模板上限；构造一个名额一个 slot。构造替换范围（本次整周草稿中的 slotId），从已发布占位撤除该范围内尚未开始的旧岗位；固定、已开始、本次范围外已发布岗位按稳定 eventId/slotId 仅保留一次作为初始占位。已开始岗位以原责任人保留、禁止解固定。候选、人工修改、生成和发布都先使用同一占位合并函数，允许解除固定后的换人与交换，禁止 fixed 和旧发布记录重复占位或重复计数。检查 fixed 全部合法，错误则返回并保留旧草稿。
2. 候选校验顺序：启用、已提交时间、department/roles、禁排、批准请假、已发布／已选时间重叠、同场重复、unique eventId 的日周上限；候选查询、生成、人工调整和发布复用这一实现。
3. 每一步重新计算剩余岗位合格候选数，先处理最少的；同数按 date/startMin/slotId。候选排序为本周 unique event 数、historyCount、historyMinutes、lastSameRoleDuty、稳定 rotation、staffId。排序是逐项比较，没有加权综合分。
4. 确定性有界回溯最多 5000 节点，记录填满岗位数最多的结果，等数保留首次结果。先试候选，再试空岗；搜索达到上限返回 bounded=true，剩余岗位显示「当前方案未排满，需人工调整」，不能称系统无解。固定岗位永不重排。相同输入、算法版本、rotation 输入返回相同结果。
5. why 保存候选条件通过与优先次序的关键数值，说明本周／近4周轮值情况；不存表现评分。保存草稿前事务复核依赖版本与周 revision，已变化返回冲突，不保存过期生成结果。

稳定轮转以该岗位有序人员列表和服务端保存的轮转序号决定，历史缺失为 0；仅发布成功推进相应岗位轮转起点，反复生成不推进；推进与发布及 receipt 同事务，同请求重试返回原结果。人工调整改变责任人，原因进 draftAudit，不能修改原历史字段。

## 并发与发布

所有身份从服务端 partner actor 决定。发布前事务读取规则、相关人员、可排时间和周文档，验证与草稿依赖一致，对每个受影响 staff/date 的锁文档写 revision；读取周文档内发布场次后复核冲突，再更新发布周、历史快照和固定通知。缺文档以明确不存在处理，数据库异常拒绝操作。超管修改资格／停用、可排时间保存和规则保存均更新所引用版本，事务重试重新读取；不能只靠客户端显示过期。

发布生成新版本后，任务统计派生自 activeStaffId，通知仅包含场次安排变动，不带请假／禁排理由。开始时责任快照由场次详情在开始后首次读或维护任务幂等固化；固化前禁止按实际已结束场次统计为 0 冒充历史，查询可从该开始时刻生效的不可变发布版本推导。

## 文件组织与实施顺序

| 文件 | 用途 |
|---|---|
| cloud/cloudfunctions/api/services/partnerShiftRules.js | 规则、场次展开与固定轮转，F2/F5。 |
| services/partnerQualification.js | 人员资格超管维护、版本与 staff 源数据摘要，F1/F4。 |
| services/partnerAvailability.js | 本人提交、代录、权限、版本，F3。 |
| services/partnerScheduleEngine.js | 候选、排序、有界搜索和校验，F4～F8。 |
| services/partnerShift.js、partnerLeave.js、partnerHub.js | 草稿依赖、事务发布、局部补位与通知，F6～F10。 |
| handlers/partner/schedule.js、router.js、handlers/index.js | 请求白名单、管理权限、路由注册。 |
| miniprogram/pages-partner/{shift-manager,shift-draft,availability,shift-rules,shift-history}/ | 社干生成、调整、发布与站员时间输入，F1～F11。 |
| cloud/scripts/init-partner.js | 新集合、索引、ADMINONLY 验证，幂等不清库。 |
| cloud/scripts/test-partner-scheduling.js | 权限、生成、版本、历史与事务并发验收。 |
| preview/partner-scheduling-codex-v1/{index.html,style.css,app.js,engine.js} | 本轮独立设计样例与交互，不接云账号。 |

正式实施分三步：先规则／资格／可排时间和候选校验，再生成／人工固定／解释，最后草稿依赖／发布／通知与补位衔接。每步对应 AC 后验收。重复生成、保存或预览不增加历史和轮转序号。

## 验证

设计预览：语法检查、确定性生成、人数不足、时间冲突、请假、固定保护、角色差异、未填满禁止发布，以及 375 像素布局。真实实施后再验证 cloud 源码及 bundle regression、客户端恢复、AdminOnly、并发改规则／停用／补位后旧稿发布失败、history 只计承担人、周日／周一历史窗口切点、同周解固定换人和交换、fixed 不重复占位、依赖变动后合法草稿可事务重新确认、校验后再次变化必须拒绝发布、发布重试轮转只推进一次、旧 weight 不读取；提交前按项目要求执行 npx jest。本轮不运行或部署尚未实现的业务功能。

## 审查与确认

基于 Explore agent 报告（round 1，4 个 major）已按 SCHED-PLAN-01～04 修正资格、占位合并、重新校验及历史／轮转依赖；未消化 critical 0、major 0。真实开发须等具体方案确认；当前 plan 是便于评估可行性的实施草案。

## 手机预览实施补充（Codex v2）

在 `preview/partner-scheduling-codex-v2/` 单独交付手机原型。复制已验证的纯排班引擎，不改变候选与发布状态规则，使用独立 localStorage 键。`index.html` 负责手机框、导航栏、胶囊导航和外部演示控制；`style.css` 全部按手机布局编写；`app.js` 将总览精简、增加日期选择、更多页与轮值分布页，并把换人／时间／发布模态框改为底部弹层。弹层内内容滚动与底部操作分开，弹层打开时隐藏手机底部导航。

主要动作与内容位于手机框内；角色和异常演示位于框外。切页重置手机内容滚动，日期切换保留当前周与草稿；发布校验仍针对完整周，不仅检查屏幕上的一天。外部场景切换不能改变身份权限。

验证复用 65 项引擎与 47 项状态检查，另增加日期过滤、整周发布校验、角色导航、弹层与移动尺寸的验证。保留 v1 桌面版，伙伴端班表入口更新为 v2；没有部署、推送或改动真实小程序代码。

手机补充单轮 Explore 审查未发现 critical 或 major，按已授权的手机设计原型范围实施。

## 超管时段配置实施补充（2026-10-08）

本轮仍只更新 Codex v2 本机设计原型。新增 `slots.js` 纯函数负责默认示例、日期展开、严格校验与时间确认摘要；`duty-ui.js` 提供时段页面、超管编辑弹层、草稿保存和独立发布动作，`app.js` 接入导航、生成依赖与人员时间确认。旧本机数据无损补充时段 v1，保留已有人员、排班草稿、发布班表和审计。时段分为 slotDraft、slotPublished（version、templates、说明）与 slotHistory。

生成输入绑定已发布时段版本，岗位保存 eventTitle 快照；发布时段先验证和比较日期／时间／部门岗位摘要，再按需将人员时间标为未提交。标题／人数调整只使草稿过期，不撤销原可排时间确认。固定岗位若日期／时间／岗位改变，阻止直接生成；显式重建归档完整旧稿并按新时段生成。已发布人员班表周拒绝新增、保存和发布时段的所有写入入口。时段发布使用本机整份数据保存，失败恢复旧数据，不改变时间确认和版本。

正式实现调整前文接口：`PUT /partner/shift-rules` 只维护 maxWeek/maxDay，模板不再随规则即时生效。新增 ADMINONLY `partner_shift_slots`（固定 ID week，draft、published、publishedVersion、revision、audit），规则与时段分开；`GET /partner/shift-slots?week=` 管理员读草稿及发布状态，站员只读发布内容；`PUT /partner/shift-slots/:week/draft` 与 `POST /partner/shift-slots/:week/publish` 仅 super，输入 expectedRevision、reason、requestId，发布另检查目标周不存在已发布人员班表。规则／时段写入、班表发布必须读写同一 week 文档并递增 revision，避免同时发布班表和改时段成功。

人员可排时间绑定 slotPublishedVersion 与时间摘要；服务端候选对摘要不符者视为未提交。发布标题／人数变化可原子继承相同摘要的提交确认，其他变更要求重新确认；不存在已发布时段时拒绝提交和生成。草稿依赖追加 slotPublishedVersion 与 slotDigest，班表发布检查版本未变。发版事件与幂等回执同事务，重试不重复使人员确认失效。已发布人员班表引用不可变时段／栏目快照，临时更正复用既有审计和责任人闭环。本轮不实现这些业务接口。

<!-- review-fix: T-SLOTS-01 -->
`PUT /partner/availability/:week` 增加 `expectedSlotPublishedVersion`，取自打开表单时的版本；保存事务同时读取当前周时段版本与摘要，不匹配返回冲突并保留客户端输入，要求重新查看新时段。不能在收到旧输入后直接盖上最新时段版本。原型同步记录表单打开版本并在确认时拒绝过期表单。单轮 Explore 审查的 1 个 major 已修正，无未消化 critical／major。

验证新增纯时段校验与状态链路检查：草稿不生效、多日期展开、权限、时间变更撤销确认、固定保护、完整旧稿归档、人数变更保留时间确认、已发布周锁定、版本及保存失败回滚；浏览器完成超管编辑 → 保存 → 发布 → 社干读新时段，并检查手机弹层与触控尺寸。
