# 菁悠伙伴端 · Codex v1.1 · 实施计划

> 作者：Codex。日期：2026-10-07。
> 依据：同目录 spec.md。此计划为随规格和独立 UI 一起审阅的实施草案；用户确认前只交付文档与原型，不修改业务模块。

## 现状与架构

`miniprogram/app.js` 默认走 cloud；`cloud/cloudfunctions/api/router.js`、`handlers/index.js` 是实际云接口入口。伙伴业务尚未实现，`weekly_schedule` 是学生点歌排期，不用于内部人员值班。北京时间工具实际为 `cloud/cloudfunctions/api/lib/bjTime.js` 与 `src/utils/bjTime.js`。

本轮在云 API 新增伙伴模块、小程序新增 `pages-partner` 分包。内部管理动作在伙伴端社干模式完成，账号建立与关联由超管完成。现有学生 API、管理员 API、Express 与 Docker 均保留；本轮不维护第二套伙伴 Express 实现。小程序伙伴请求仅支持 cloud，选择 direct 时明确提示该模块须使用云通道。

依赖方向：页面 → 伙伴请求门面 → 路由／鉴权 → 待办、稿件、班表服务 → 伙伴事务存储。服务只依赖鉴权后的 actor 数据与存储，不反向调用页面、handler 或聚合待办服务。

## 身份与权限（F1）

<!-- review-fix: PLAN-F13-01 -->
- `POST /partner/login` 接收 `{kind:'member'|'admin',username,password}`，返回 `{token,actor:{key,kind,name,role,staffId}}`；admin 登录另返回 `managementSession:{token,admin:{id,username,nickname,role}}`。member 查新增站员账号；admin 查既有管理员账号并验证 bcrypt。伙伴 token 包含 `aud:'partner'`、`partnerActor`、`kind`、`pv`，不含可被既有管理鉴权误认的 `id`／`username` 组合。managementSession 使用独立签名密钥 `PARTNER_MANAGEMENT_JWT_SECRET`（必须配置、不得与既有 JWT_SECRET 相同或回退），固定 HS256、aud=partner-management、issuer=jingyou-partner，payload 为 `{id,username,role,source:'partner-management',partnerActor,credentialVersion}`，版本算法与下文伙伴管理员 token 相同；仅在同一管理员账号验证成功后建立，member 绝不获得。密码不进入请求日志和响应缓存。
<!-- review-fix: PLAN-03 -->
- `requirePartner(ctx)` 每次核对 audience、对应账号是否存在、启用状态及密码版本；站员用账号 pv，管理员用 `credentialVersion=HMAC-SHA256(服务端 secret,当前 passwordHash)`，token 不放原密码或完整 hash，请求时重新计算并恒定时间比较。既有管理员改密／重置改变 hash 后，旧伙伴 token 随之失效，不要求修改其既有账号结构。管理员角色从当前 admin 记录读取，不信 JWT 内旧角色。actor key 为 `member:<账号字符串 ID>` 或 `admin:<既有 ID>`，避免同号串人。
- `requirePartnerManager(actor)` 仅接受 admin 且当前 role 为 0 或 1；`requirePartnerSuperAdmin(actor)` 仅接受当前 role 为 0。稿件 author 与审核人比较 actor key，禁止自己审核。安全复核人由超管指定的 admin ID 决定，未指定时只允许超管，且仍不能自审。
<!-- review-fix: PLAN-F13-02 -->
- `partner_token`／`partnerInfo`／`globalData.partnerToken` 独立；请求库新增明确 partner scope 及专用 401 清理，错误 scope 不回落到学生 token。配对会话以单个 `partner_management_session` 存储项作为权威状态，结构 `{partnerActor,adminId,token,admin,tokenDigest,source,epoch}`；同一对象一次 setStorageSync 写入，tokenDigest 为 SHA-256(token)，不用于鉴权，仅验证镜像一致。既有 admin_token、adminInfo、globalData 是兼容镜像，写入并读回成功前不启用管理入口；任一步失败则撤销配对会话并提示重新登录。每次从伙伴入口进入旧页或发出管理请求前，必须核对实际 admin_token 的摘要、adminInfo.id、伙伴 actor、source 和会话代次全部一致，不能只比较 ID 标记。
- 既有 `app.adminLogin` 在开始独立管理员登录时使配对绑定失效，再按原流程写新 admin 会话；`adminLogout`、管理端 401 同时清配对绑定。伙伴退出、401、切换站员时，仅当实际 admin token 与绑定摘要匹配才清理该配对镜像，不能删除后来独立登录的管理员会话。请求与登录回调捕获 epoch 及发送 token，旧回调不得改写新会话，旧请求 401 不得清掉新 token。启动恢复验证单个权威项与全部镜像、伙伴身份的一致性，缺失或不匹配即禁用配对入口并重新登录；独立 admin 登录不能冒充旧配对会话。学生登录态保留。旧管理 API 仍由 `adminRequest` 使用 admin_token，绝不拿伙伴 token 调用，也不伪造 ctx.admin 绕过现有 `asAdmin`。
- 云网关 `index.js` 在 HTTP 事件归一化、路由匹配后且分发任一 `/admin` handler 前，调用 `partnerAuth.assertPairedManagementFresh(ctx)`。云 `lib/auth.verify` 增加配对 JWT 的签名验证分支，强制固定算法、aud、issuer 和 source，并禁止既有密钥签出的 token 声称配对来源；旧 token 仍按原密钥验证。此函数使用验证过的 payload，再仅对 source=partner-management 的 token 逐请求读取当前管理员，核对存在、status=1、username、partnerActor、恒定时间比较 credentialVersion，并要求当前 role 与 token.role 相同；改密、停用、删除或角色变化均返回 40101，不能继续分发。数据库失败拒绝请求，不降级放行。旧独立 admin token 延续现有行为；此校验覆盖云调用及云 HTTP，配对会话客户端仅走 cloud，不能切 direct。原 handler 的 requireAdmin／requireSuperAdmin 仍执行并复用同一签名验证函数，网关校验不替代它们。旧 Express 只持有原 JWT_SECRET，不能验证新增配对密钥，所以直接送到旧 Express 的配对 JWT 必须因签名错误被拒绝，回归同时覆盖此路径。
<!-- review-fix: PLAN-05 -->
- 账号新建与停用、管理员的 staff 关联均只允许超管：`POST /partner/accounts` 接收 `{username,staffId,requestId}`，返回 `{account:{id,username,staffId,status},initialPassword}`；`PATCH /partner/accounts/:id` 接收 `{status:'enabled'|'disabled',expectedPv,requestId}`，仅允许状态字段，返回不含 hash 的 account，停用递增 pv；`PUT /partner/admin-links/:id` 接收 `{staffId:null|string,requestId}`，校验 admin 与人员存在，返回 `{adminId,staffId}`。用户名 1～40 字、唯一；初始密码随机产生，只在建立成功响应中返回一次，幂等重试不再次返回明文，存储仅 bcrypt hash。人员预约键禁止一个 staff 同时对应多个可排班账号，解除关联须检查未完成班次与请假。
- 查询最小集：`GET /partner/accounts?status=&cursor=&limit=`（超管，1～30 条，返回 `{items:[{id,username,staffId,name,status,pv}],nextCursor}`）；`GET /partner/admin-links?cursor=&limit=`（超管，返回 `{items:[{adminId,name,role,staffId}],nextCursor}`）；`GET /partner/people?department=&cursor=&limit=`（manager，返回 `{items:[{staffId,name,department,linked,enabled}],nextCursor}`）；`GET /partner/authors?cursor=&limit=`（manager，返回已启用作者 `{items:[{actorKey,name,staffId}],nextCursor}`）。过滤字段、分页白名单服务端验证，响应不含 hash、token、请假理由。已占用关联／重复用户名为 40910；角色字段提交为 40001，不由客户端设角色。任务分派从 authors 选人，不能借用既有 /admin 路由。

统一错误：40101 未登录／失效；40301 权限或所有权不足；40001 入参非法；40401 数据不可见或不存在；40910 revision／岗位占用冲突；40911 状态转换非法；50310 内容检测不可用。冲突响应附 `{currentRevision,currentState}`，正文只返回给稿件作者或有审核权限的管理员。

## 数据结构

云新增集合使用字符串 `_id`，新实体以服务端 `crypto.randomUUID()` 创建；固定逻辑记录使用由服务端计算的稳定键。时间戳为毫秒，日期为北京时间 `YYYY-MM-DD`，正文纯文本，客户端不能提交 `_id`、角色或审核字段。

| 集合 | 核心字段与不变式 |
|---|---|
| `partner_member_account` | `username:string(1..40)`、`passwordHash:string`、`staffId:string`、`status:enabled/disabled`、`pv:int>=0`；登录名唯一；禁用立即阻止请求与补位。 |
| `partner_admin_profile` | `_id=admin:<id>`、`staffId:string|null`；映射仅改变排班身份。安全复核人设置存现有 KV `partner_safety_reviewer_id`。 |
| `partner_draft` | `authorKey`、`programId`、`title:string(1..80)`、`content:string(0..10000)`、`dueAt:ms`、`targetSec:int(30..1800)`、`shiftKey:string|null`、`revision:int`、`nextVersion:int`、`latestVersionId`、`approvedVersionId`、`state:editing/checking/check_failed/safety_review/pending/returned/approved`、`updatedAt`；每次变更递增 revision。 |
| `partner_script_version` | `_id=<draftId>:<版本号>`、`draftId`、`number:int`、`title`、`content`、`authorKey`、`submittedAt`、`safetyState`、`safetyAttempt:int`、`safetyAttemptStartedAt:ms`、`review:{actorKey,action,reason,at}|null`、`safetyReview:{actorKey,action,reason,at}|null`；提交正文及作者永不可改，状态元数据可按合法转换更新。 |
| `partner_shift_week` | `_id=week:<周一日期>`、`revision:int`、`draftSlots:array`、`draftBasePublishedVersion:int`、`draftStale:boolean`、`publishedSlots:array`、`publishedVersion:int`、`publishedAt`、`history:array`；每岗位稳定 `slotId`，含 `date,startMin,endMin,department,role,originalStaffId,activeStaffId,leaveId`；时间范围同日、0≤startMin<endMin≤1440；history 保留发布快照与操作者／原因。每周最多 100 个岗位、单槽最多 200 条变更，达到上限拒绝新增并提示分周管理，既有历史不裁切。 |
| `partner_leave` | `_id=leave:<uuid>`、`slotKey`、`applicantKey`、`originalStaffId`、`startAt,endAt`、`scheduleVersion`、`revision:int`、`reason:string(1..300)`、`status:pending/approved/rejected/withdrawn/invalidated`、`replacementStaffId:null|string`、`history:array`；同岗位同时仅一项 pending 或 approved，请假理由不对其他站员返回。 |
| `partner_notice` | `_id=<操作幂等键>:<接收 actor>`、`recipientKey`、`kind:leave_result/shift_change`、`targetId`、`createdAt`、`readAt:null|ms`、`summary`；消息不得包含请假理由。 |
| `partner_receipt` | `_id=<actor>:<操作>:<客户端请求 ID>`、`requestDigest`、`result`、`createdAt`；相同键和参数返回原结果，相同键不同参数拒绝。该集合也保存固定 username／staff 预约键与 `person-day` 冲突锁文档，锁文档只递增 revision。 |

<!-- review-fix: PLAN-04 -->
账号、草稿、消息的查询索引：username 唯一、authorKey+dueAt、draftId+number、recipientKey+readAt+createdAt、slotKey+status、applicantKey+createdAt。集合与索引由幂等初始化脚本建立，已有集合不清空。全部 partner 集合权限必须设置并读取验证为 ADMINONLY（拒绝客户端直接读写）；规则未设置成功或验证不一致时初始化失败，禁止上线。所有访问由云函数服务端 SDK 执行，不能依赖客户端规则过滤来代替 handler 鉴权。

## 首页待办（F2）

`GET /partner/hub` 返回 `{now,actor,nextShift,tasks,unreadCount}`。task 为 `{id,kind,title,dueAt,createdAt,target:{page,id},state}`。服务端只查询 actor 所有稿件、本人班次／消息；社干另查 pending 审核、pending 请假、activeStaffId 为空的已发布岗位。逾期优先，其他按 dueAt（无截止为最大值）、createdAt、id 排序；最多 30 条并返回 `hasMore`，`GET /partner/todos?cursor=&limit=` 分页。最近班次从已发布班表查找本人 activeStaffId 的未来场次。

`PUT /partner/notices/:id/read` 只允许接收人操作，重复阅读返回成功。行动待办直接由当前业务状态派生，不维护第二份任务状态；结果通知只按未读派生。空列表正常返回，读取失败显示重试，不用空数组伪装成功。

## 既有审核与管理入口（F13）

社干首页将「听众投稿」和「站内协作」分区。`/partner/hub` 只聚合新增内部事务；客户端并行用配对 admin 会话读取 `/admin/submit/list?type=1&reviewStatus=0&page=1&pageSize=1`、同接口 `type=2` 与 `/admin/message/list?status=0&page=1&pageSize=1` 的 total。只在各计数都成功时展示总数；失败模块明确显示重试，其他已成功模块仍能使用。计数表示全部待处理，返回审核页后在 onShow 重新读取，不能将原总数减 1 当成服务端真值。

- 投稿列表复用 `pages-admin/review/review`，新增 whitelist type=1／2 导航参数及页面切换；fetchCounts、fetchList、详情连续审核队列都透传当前 type，按 reviewStatus=0／1／2 筛选。详情复用现有审核处理台；通过走 `PUT /admin/submit/:id/approve`，驳回走 `PUT /admin/submit/:id/reject` 且 reason 必填。操作后重新读详情、列表与计数，展示服务端最终 reviewStatus、scheduleStatus、playStatus；不把审核成功等同排期或播放。既有周锁拦截错误须原样提示，不新增审核规则或表。
- 留言复用现有管理页和 `/admin/message/list`、`PUT /admin/message/:id/approve`、`PUT /admin/message/:id/reject`；屏蔽理由必填。处理完成后重新读取待审数，不提供当前业务不存在的留言回复或置顶。
- 歌曲排期只读页调用 `GET /admin/submit/schedule`、`GET /admin/submit/week` 及已通过候补列表（scheduleStatus=2），以实际返回结构展示周锁、已排期与候补。入口对 manager 可见；无执行排期、指派、锁定／解锁或标记播放按钮。新增分包只读页不与人员值班页复用数据源。
- 栏目、公告、招新、数据看板保留电脑后台入口提示，指向现有后台相应功能，不复制四套业务到手机；正式域名从项目配置读取，不在代码猜写地址。当前独立原型仅展示说明弹层。

管理权限继续由原 `/admin` handler 决定，伙伴模块不扩大 role=1 的既有权限。必须回归：站员无配对管理会话、错身份不能打开旧管理页、普通社干直调排期或标记播放仍被拒绝、锁定周审核仍失败、type=2 学生文稿与 partner_draft 完全独立。

配对会话新增必验：管理员改密、停用、降权后，直接拿旧配对 token 调审核和超管接口均被服务端拒绝；A 伙伴登录后从旧入口登录 B，A 的配对入口不能以 B 发请求；单独退出、管理端 401、重启恢复、镜像写入中断都不能留下可用的错误绑定；A 的迟到 401 不能清理 B 的新会话。

## 稿件保存、版本与审核（F3～F6）

| 接口 | 参数与成功返回 |
|---|---|
| `POST /partner/drafts` | `{title,programId,dueAt,targetSec,shiftKey?,authorKey?}`；本人创建，manager 才能指定其他作者；返回完整 draft。 |
| `GET /partner/drafts` | `filter=all/working/approved,cursor,limit(1..30)`；站员只返回本人，manager 可按 author 查询；返回 `{items,nextCursor}`。 |
| `GET /partner/drafts/:id` | 返回 draft 与可见最新处理意见。 |
| `PUT /partner/drafts/:id` | `{expectedRevision,title,content,programId,dueAt,targetSec,shiftKey?,requestId}`；作者保存，manager 仅能调整任务元数据；返回 `{revision,updatedAt,draft}`。待检测／安全复核／普通审核期间只读。 |
| `POST /partner/drafts/:id/submit` | `{expectedRevision,requestId}`；事务内从已保存正文创建 version，state=checking；返回 `{versionId,revision,state}`。 |
| `GET /partner/drafts/:id/versions` | 返回所有版本元数据；`GET /partner/versions/:id` 返回不可变正文与处理记录。 |
| `POST /partner/drafts/:id/restore` | `{versionId,expectedRevision,requestId}`；作者恢复成编辑稿、revision+1，旧提交快照不改；返回 draft。 |
| `POST /partner/versions/:id/retry-check` | `{expectedAttempt,requestId}`；作者可在 check_failed，或服务端计算距 safetyAttemptStartedAt 已超过 60 秒的 checking 重试；未超时为 40911，非最新版本／attempt 为 40910；返回新 attempt 与 checking。 |
| `POST /partner/versions/:id/end-submission` | `{expectedRevision,requestId}`；作者仅在 check_failed 结束提交，保留版本和失败记录，draft 回 editing。 |
| `POST /partner/versions/:id/review` | `{action:approve/return,reason,expectedRevision,requestId}`；manager，必须 version 为最新且 safetyState=pass，return 理由 1～500 字；返回 `{state,approvedVersionId,revision}`。 |
| `POST /partner/versions/:id/safety-review` | `{action:pass/reject,reason,expectedRevision,requestId}`；指定安全复核人，理由 1～500 字，禁止自审；pass 转 pending，reject 转 returned；返回处理记录与 draft state。 |

自动保存为单稿件串行队列：每次输入先 `wx.setStorageSync` 保存 `{actorKey,draftId,baseRevision,title,content,localSequence}`，键为 `partner_draft:<actorKey>:<draftId>`；1 秒防抖发送，期间的新输入留在下一队列。响应只能确认其发送时的 localSequence，不能把后来输入标成已同步。超时、冲突均保留本机内容；稿件切换／退出账号使旧回调失效。恢复页面同时读取服务端 revision 与本机 baseRevision，不拿设备时间强行覆盖；副本列表有查看和恢复入口，恢复前追加保留当前稿。

<!-- review-fix: PLAN-01 -->
提交必须先等保存队列清空，再以最新 revision 建快照。版本检测调用不在数据库事务内：先建立 checking 版本与 attempt 和服务端 safetyAttemptStartedAt，再以该版正文调用严格内容安全服务，返回时只更新仍是同一 attempt 的版本。云函数在建立快照后执行有界检测并写结果；执行中断时版本留 checking，超过 60 秒后允许由同一个作者发起重新检测。重试事务同时检查最新 version、draft state、expectedAttempt，递增 attempt 并更新开始时间，旧 attempt 的迟到结果只记录诊断，不修改新状态。回归覆盖执行中断恢复和旧结果不能放行新版。

`services/wechat.js` 当前是异常时放行，不能用于本模块的安全闸门。新增 `partnerSafety.js` 只在明确得到通过结果时置 pass；关闭检测配置、缺凭据、调用异常、超时全部置 check_failed。命中为 safety_review。使用可信云调用上下文取得调用者微信身份；本轮稿件提交仅由小程序云通道发起，不接受客户端自行声明微信身份。HTTP 管理调用可审核已过检稿件，不能绕过检测直接建 pending。

通过审核只更新 draft.approvedVersionId，正在修订的 title/content 不用于播出。所有变更在事务内验证作者、version、revision、当前状态和幂等键。

## 班表、请假与补位（F7～F11）

| 接口 | 参数与成功返回 |
|---|---|
| `GET /partner/schedule?week=` | 站员仅返回 publishedSlots 及不含请假理由的变更摘要；manager 可加 `view=draft` 看草稿；返回 `{week,revision,publishedVersion,slots,changes}`。 |
| `PUT /partner/schedule/:week` | manager；`{expectedRevision,basePublishedVersion,slots,reason,requestId}` 建立／保存草稿；base 必须等于当前 publishedVersion；校验人员、岗位、日期与时间边界；返回草稿、draftBasePublishedVersion 和 revision。 |
| `POST /partner/schedule/:week/publish` | manager；`{expectedRevision,expectedBasePublishedVersion,reason,requestId}`；同时核对草稿基线与当前发布版本，draftStale 为 true 则 40910；校验冲突，将草稿发布成新版本，保留旧快照与人工变更；返回 publishedVersion。 |
| `POST /partner/leaves` | 作者；`{slotKey,expectedScheduleRevision,reason,requestId}`；只能本人已发布未来岗位；返回 leave。 |
| `GET /partner/leaves/:id` | 申请人或 manager 可见完整理由、history、replacement；他人 40401。 |
| `POST /partner/leaves/:id/withdraw` | 申请人；`{expectedRevision,requestId}`；仅 pending 且未开始；返回 withdrawn。 |
| `POST /partner/leaves/:id/decision` | manager；`{action:approve/reject,reason,expectedRevision,expectedScheduleRevision,requestId}`；校验申请人员／时段仍有效；approve 清 activeStaffId 并挂 leaveId，reject 保持班表；返回 leave 与岗位状态。 |
| `GET /partner/leaves/:id/candidates` | manager；返回 `{scheduleRevision,items:[{staffId,name,eligible,reason}]}`；不返回密码、其他请假理由。 |
| `POST /partner/leaves/:id/replacement` | manager；`{staffId,expectedRevision,expectedScheduleRevision,reason,requestId}`；二次冲突校验，原子更新 leave、班表新发布版本与双方 notice；返回 `{leave,publishedVersion}`。更换人员使用同接口，reason 必填。 |
| `POST /partner/leaves/:id/correction` | manager；`{action:remove_replacement/revoke_approval,expectedRevision,expectedScheduleRevision,reason,requestId}`；reason 必填；remove 保持 approved 与缺岗，revoke 校验原人员无冲突后恢复且清替补；冲突时完整回滚。 |
| `POST /partner/schedule/:week/correction` | manager；`{slotKey,expectedRevision,attendanceNote,reason,requestId}`；已开始场次仅追加事实更正记录，不改写原发布快照。 |

<!-- review-fix: PLAN-02 -->
班表草稿与发布状态在同一周文档分别存储。发布同时校验 expectedRevision 和 draftBasePublishedVersion；批准请假、补位或更正每次改变 publishedSlots 时也递增 publishedVersion，把旧 draftStale 置 true。刷新客户端不能解除 stale。社干需明确选择「以最新已发布班表重新建立草稿」，服务端复制 publishedSlots、设新基线，原草稿留在历史供回看；再手工调整。增加 `POST /partner/schedule/:week/rebase`，manager，参数 `{expectedRevision,expectedPublishedVersion,requestId}`，返回 `{draftSlots,draftBasePublishedVersion,revision}`。发布变更涉及的旧请假，若人员或时间不再相同，事务内标 invalidated、清理对应 leaveId 并发变更通知。回归必须覆盖「保存草稿 → 补位 → 刷新 → 发布旧草稿失败」。

单纯查候选不能防跨场次并发安排同一个人：每次发布／批准／补位／撤销批准同时更新受影响人员的 `person-day:<staffId>:<date>` 锁文档。事务读取该人员当天所有候选班表（日期决定周文档 ID，不在事务中做不受保护的列表查询），按半开区间检测，然后写锁和对应周文档；同人员同日两笔并发安排产生事务冲突，重试时重新校验。周最多 100 个岗位，可完整读取一周判断；候选列表查询与事务二次校验使用同一逻辑。

批准时为原人员生成 leave_result；补位时分别通知原人员和替补，以变更 action ID+actor 做固定 notice ID，重试不会重复。管理员若未关联 staff，仍能审批，但不能作为候选。

## 文件组织与功能映射

| 文件 | 职责与覆盖 |
|---|---|
| `cloud/cloudfunctions/api/services/partnerAuth.js` | 登录、动态角色、状态与密码版本、账号管理、配对管理凭据新鲜度校验（F1、F13）。 |
| `cloud/cloudfunctions/api/index.js`、`lib/auth.js` | 配对 JWT 独立密钥／aud／issuer 校验；旧 /admin handler 分发前验证新配对凭据当前状态，云／HTTP 均覆盖；配置缺失拒绝发放（F13）。 |
| `cloud/cloudfunctions/api/services/partnerStore.js` | 隔离伙伴集合常量、事务、固定键、严格缺文档判断；参考现有 recruitmentStore 实际事务模式。 |
| `cloud/cloudfunctions/api/services/partnerDraft.js` | 任务、保存、快照、恢复、审核（F3～F6）。 |
| `cloud/cloudfunctions/api/services/partnerSafety.js` | 版本绑定的严格安全检测与人工复核（F6）。 |
| `cloud/cloudfunctions/api/services/partnerShift.js` | 草稿、发布、冲突与事实更正（F7、F11）。 |
| `cloud/cloudfunctions/api/services/partnerLeave.js` | 申请、审批、补位、更正、变更消息（F8～F11）。 |
| `cloud/cloudfunctions/api/services/partnerHub.js` | 服务端按身份聚合待办与下次值班（F2）。 |
| `cloud/cloudfunctions/api/handlers/partner/{auth,hub,draft,shift,leave}.js` | 入参边界、权限调用与响应；router 新增 PARTNER_ROUTES、handlers/index 用字面量 require 注册。 |
| `miniprogram/utils/request.js`、`miniprogram/app.js` | 伙伴 scope、配对权威状态及镜像；旧 adminLogin／adminLogout／管理 401／启动恢复维护绑定与 epoch，阻止串身份和迟到回调（F1、F13）。 |
| `miniprogram/pages-partner/{login,hub,scripts,editor,versions,schedule,leave,manager,song-schedule}/index.{js,json,wxml,wxss}` | 身份、三闭环页面、社干汇总及歌曲排期只读页；`app.json` 新分包。入口放「我的」页登录信息后的独立「伙伴工作台」行（F1～F13）。 |
| `miniprogram/pages-admin/review/` 与现有投稿详情、留言页 | 复用既有审核流程，增加 type 参数与返回刷新；不复制既有审核 handler（F13）。 |
| `miniprogram/pages-partner/utils/{request,draft-cache}.js` | 伙伴门面、按账号稿件隔离的本机保存与恢复（F4）。 |
| `cloud/scripts/init-partner.js` | 集合、索引、账号唯一预约键幂等初始化；设置并读回验证 ADMINONLY，失败停止。 |
| `cloud/scripts/test-partner-{auth,draft,shift,leave,client}.js` | 用既有 harness 校验权限、保存竞争、版本、安全状态、事务回滚和客户端恢复。登记 regression。 |
| `preview/partner-hub-codex-v1/{index.html,style.css,app.js,management.js}` | 本次独立可操作 UI，署名 Codex v1.1；只用本机演示数据（F12、F13）。 |

## 技术决策

| 决策 | 选择与理由 | 未采用的备选 |
|---|---|---|
| 服务落点 | 云函数实现，匹配当前真实上线通道 | 只改 Express 会让默认 cloud 小程序访问不到。 |
| 站员账号 | 独立账号关联 staff，管理角色仍来自 admin | 增加 admin role=2 会扩大既有管理鉴权风险。 |
| 保存策略 | 本机即时副本＋串行同步＋revision 检查 | 仅防抖保存不能覆盖立即退出；最后写入胜出会丢稿。 |
| 提交与播出稿 | 不可变快照与 approvedVersionId | 审核当前可编辑正文会让结论失效。 |
| 班表存储 | 有上限的周文档，草稿／发布分别存；读写 revision | 每岗位独立盲写难以保证跨场次冲突和发布快照；本期不引入求解器。 |
| 安全检测 | 隔离严格检查器，以版本与 attempt 绑定结果 | 现有通用 helper 异常放行，与伙伴稿件硬闸门不符；不修改学生端既有行为。 |
| 补位 | 社干直接指定合格人员，完成即更新站内事项 | 增加站员接单确认会引入新流程，用户本轮未要求。 |
| 原型 | 从零编写独立 HTML/CSS/JS，遵循公共色板 | 不复制或比较其他伙伴端 UI，不接真实生产数据。 |

## 实施与验证顺序

1. **M1 身份与稿件基础**：云集合／账号／权限 → 任务与保存 → 提交快照／安全／审核 → 客户端本机恢复。验收 AC1、AC3～AC6。
2. **M2 班表与请假闭环**：人工班表 → 草稿发布 → 请假／审批 → 补位／更正与通知。验收 AC7～AC11；并发用可控制的事务冲突而非顺序调用冒充。
3. **M3 首页与整合**：状态派生待办 → 管理配对会话与既有审核入口 → 页面跳转与已读 → 独立 UI 落入分包。验收 AC2、AC12、AC13；覆盖 375 像素窄屏及手机开发者工具。

每个里程碑独立通过后再推进下一个。额外必验：既有后台改密后原伙伴 token 失效；初始化权限读回正确；客户端不能直接读请假理由或写审核状态；checking 超时恢复；补位后旧草稿不能发布。实现完成执行相关 cloud regression 源码与 bundle 两轮、request facade 回归与全量 JS 语法检查；提交前执行项目要求的 `npx jest`，如遇真实微信 appid 环境问题如实区分。先生成云 bundle 再核对路由可加载，不直接修改 `miniprogram/cloudfunctions/api` 产物。

本次原型验收只验证预览交互和布局，不以本机演示通过代替上述业务验收。业务实现前仍需确认规格与 UI；本次没有数据库迁移、真实账号建立、自动发布或 git push。

## 已知限制

基于初版 Explore agent 报告（round 1，5 个 issue）已按五个改写目标修正。v1.1 增补单轮审查发现 1 个 critical 与 1 个 major，已按 PLAN-F13-01／02 修正服务端凭据失效及客户端绑定职责；未消化 critical 0、major 0。两文档仍待用户与 UI 一并确认。

周文档规模有上限，未来超出校园广播站规模时再分离发布快照与岗位记录。本轮无外部推送，站员要打开工作台查看变更。AI 生成与自动排班未启用；语速在预览使用 220 字／分钟明确示意，上线的栏目参数仍须实测配置。
