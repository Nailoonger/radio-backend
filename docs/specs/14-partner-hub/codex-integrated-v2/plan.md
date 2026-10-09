# 菁悠伙伴端·Codex v2 整合实施

## 架构

新增 `preview/partner-hub-codex-v2/`，父页面拥有一个手机壳、统一导航及演示身份。稿件／审核视图和排班视图分别复用已验证的 Codex 代码，以嵌入页面呈现；子页面只显示内容和必要操作弹层，不显示另一个手机框、另一套身份控制或胶囊导航。父壳保留两份已加载视图，切换不重建编辑器，页面跳转通过同源消息协调，不跳往旧原型 URL。

新增 `store.js` 与 `workflow.js`。store 用单一 `codex_partner_hub_v2` 本机键存 `{work,schedule,role,revision}`；每次保存从最新存储合并相应域，避免另一模块被旧内存覆盖。双方读取时检查 revision，需要时刷新；涉及请假与班表的转换在一次本机 setItem 内保存两个域，失败保留旧数据。独立新样例不覆盖旧原型，初始化稿件沿用样例，初始班表未发布、请假为 none，不能凭静态页面假造班次。

<!-- review-fix: INT-R2 -->
saveDomain 接收上次读取的域基线，按顶层字段比较差异，只合并当前视图实际改动的字段；若最新存储的同一字段已偏离基线则拒绝，不能静默覆盖。work 重新读取时仅更新未本地修改的字段，dirty 正文、标题与恢复副本保留；另一个视图只改请假时不会触碰 draft。请假、批准和补位调用事务函数直接读取最新存储，不先将旧 work 内存整份保存。保存完成返回新基线；失败保留本机输入和旧存储。

work 复用 management.js、稿件及审核状态机，接入统一存储。新 bridge 覆盖过去写死日期的首页班次、班表、请假和补位页面，读取 schedule.published；原用户编辑器和版本流程继续使用原状态。调页不会按 scene 改角色，super 在原审核模块映射为管理权限，实际操作者由父身份显示。scheduler 复用 engine.js、slots.js、duty-ui.js 和原状态机，仅替换读写存储及嵌入导航；生成、发布、人员确认继续使用统一 schedule 域。

## 跨模块闭环

work.leave 增加 slotId、personId、day、start、end 与申请时发布版本。申请只能选 published 中 personId=gu 的岗位；绑定快照须与审批时当前岗位完全一致，发布版本变化但该岗未变仍允许。批准在同一保存中添加 approvedLeaves，清空该 published 岗位、发布版本加一、追加不可变发布历史、更新 work.leave 和首页未读标志。原 schedule.draft 保留，input 中旧 publishedVersion 会使其过期。

<!-- review-fix: INT-R1 -->
排班草稿追加 basePublishedVersion，生成或建立修订时固定为当前 publishedVersion。批准／补位改变正式版本后，普通 validate 不得重写发布基线，publish 独立拦截基线不同的草稿。必须通过既有 revise 从最新 published 建立新草稿，原稿先留 snapshot；所有现有正式岗位默认固定。整合 bridge 覆盖生成、校验、发布入口和冲突提示，不仅依赖 input 指纹。

候选和提交都调用 CodexScheduler.eligible/rankCandidates，输入当前 published、people、rules、approvedLeaves、externalAssignments，空缺岗位只计一次。补位要求 approved、同一 slotId 当前 personId=null、申请的时间岗位仍匹配、候选仍合法、原因非空；一次保存将该岗位责任人替换、publishedVersion 加一、发布历史留快照、work.leave.replacement 留姓名与 personId，待补位派生为 0。失败、重复操作或过期绑定均不写数据。原稿件仍属 Gu，学生投稿不进入内部稿件版本库。

## 文件与验证

父壳 `index.html/style.css/app.js`；`work/` 复用旧 hub 内容并加 `integration.js`；`scheduling/` 复用 v2 排班视图并加 `integration.js`；共享 `store.js/workflow.js` 及纯验证脚本。消息必须核对 origin、对应 iframe.contentWindow、类型与角色／路由白名单，子页不能用旧 hash 触发自动提权。保存失败保留当前稿件输入，发布型转换全量回滚。

2026-10-08 展示纠正沿用原 1.1 三栏框架，父壳实际样式为 `portal-shell.css`。左栏完整 20 场景采用 `data-preview-route`／`data-preview-role`，仅手机外的演示控件可以切身份并导航；手机内 `data-route` 继续校验当前权限。右栏通过场景说明映射渲染四个 note 节点与可点击试用捷径。保留两模块视图、统一存储和原有业务动作，增加真实父脚本的 VM 导航验证。

### 日期、超管工作台与审核处理台增量

- 按用户最新指令取消 DatePopover 组件、样式、绑定和对应验证脚本。正式班表恢复 `week-strip`，排班恢复 `date-strip`，沿用原有 `data-day` 事件；超管时段配置恢复可见的日期 checkbox，保存继续读取选中日期，不改变业务存储。
- 歌曲审核移除随日历新增的日期筛选状态与按钮，保留类型／审核状态筛选及连续处理队列。入口与内容脚本使用 `date-restored-v13` 更新缓存。
- `work/integration.js` 的超管首页分支读取同一 store 的 work／schedule，`work/super-dashboard.css` 承载手机样式；社干原首页保留。
- `work/management.js` 适配正式 `admin-web/src/views/SubmitList.vue` 审核处理台的内容与动作顺序，`work/review-desk.css` 承载手机队列和处理台。原 submissions／submission-detail 路由继续使用，歌曲与文稿类型保留；连续队列使用条目 ID，选择和提交时重新确认待审核状态，驳回记录理由、操作者及演示时间。保存失败恢复原行，不跳到下一条。
- 保留超管首页、审核处理台验证；还原后复跑共享状态、工作桥和父导航检查。只修改独立 Codex 原型，保留现有 1.1 三栏与用户数据。

验证范围：单一导航、角色边界、原稿件与审核动作、发布后班表联动、岗位申请绑定、批准产生缺岗、合格候选局部补位、首页计数／版本更新、旧稿过期、存储原子回滚与独立键；浏览器从排班发布→站员请假→社干批准／补位→站员查看走完整链路，再核对手机尺寸和稿件切页保存。正式 API 事务、实际登录和通知仍按已批准总体规格后续实现。

经单轮 Explore 审查修正 INT-R1／INT-R2，无未消化 critical／major；按用户当前整合指令继续制作设计预览。

## 2026-10-09 社干工作台局部实施

- F10／F11 由 `work/management.js` 的原 `renderManagerOverview` 函数承载；仅替换该函数的显示模板，计数继续调用现有 `managementCounts`，班表只读 `hubEnvelope().schedule`，身份只读 `hubActor`。函数只返回 HTML，不调用保存或状态转换。
- 新增 `work/manager-dashboard.css`，所有规则以 `.manager-dashboard` 为根限定，只在新的社干根节点匹配；采用白色入口分组和深色待办总览。保留工作台原入口的 `data-management-go`／`data-type`、`data-work-tab`、`data-portal-route`、`data-web-module`，继续使用原事件处理。
- 仅在 `work/index.html` 加载局部样式并更新管理脚本缓存版本。保留 `work/integration.js` 的超管分支和原包装函数，不修改父壳、公共样式、共享状态或其他视图。使用独立作用域避免公共样式引起其他页面改变。
- 验证 AC11／AC12：复跑真实工作桥、超管工作台和审核处理台检查；用实际社干渲染函数检查待办变化、班表发布状态、原入口和无存储写入；比对本次改动前后的文件指纹，确保管理脚本只有该渲染函数变化。若浏览器工具不可用，明确保留视觉复核限制。

<!-- review-fix: MGR-1 -->
社干总览的补位计数标为“请假待补”，完成提示限定审核与请假事项；班表卡单独显示全部正式缺岗，保留原计数逻辑，避免无绑定请假时误称岗位已齐。单轮增量规格及计划审查均无 critical／major。

### 社干新版入口加载修复

用户反馈页面未变化后，核对发现当前浏览器地址为旧独立排班预览；整合父壳和工作 iframe 的资源标记仍为 v14。现仅更新父壳脚本、工作 iframe 及社干模板／样式的缓存标记为 `manager-workbench-v16`，排班 iframe 继续原标记。明确的 `?preview=manager#manager` 外部预览入口调用原有身份切换一次，成功后移除 `preview` 参数；普通链接及手机内导航不改变角色，稿件和班表数据保留。

导航 30 项、容器 43 项通过；额外以内存 VM 确认三种原身份进入社干、一次性参数清理、QA 隔离、保存失败不切身份、普通链接与其他路由无影响。父壳、工作 iframe、模板和样式均 HTTP 200。浏览器自动化仍因 trusted Node process exited unexpectedly 无法完成视觉复核。

## 2026-10-09 审核界面局部实施

- F12／F13 只调整 `work/management.js` 的审核列表、详情、留言渲染函数、审核底部按钮模板与投稿驳回表单模板；复用原有条目 ID、类型／状态筛选变量、处理队列和所有动作属性。记录、权限、保存、回滚及计数函数保持原样。
- 重整 `work/review-desk.css`，规则限定到审核队列、处理台、留言页、审核操作区或独立理由表单，避免修改通用筛选器与全局弹层样式。类型用两格分段控件，状态用三格筛选；投稿改为独立白色卡片，详情将内容、结果、记录分组，按钮统一触控尺寸。
- 原有歌曲、学生文稿及留言数据只读用于渲染；不生成不存在的姓名、提交时间、审核历史或播出结果。未记录信息明确标示，完整正文只在列表作摘要展示，处理台完整保留。
- 同步更新父壳脚本、工作 iframe、审核脚本与样式的缓存标记至 `review-ui-v17`；普通地址保留当前管理身份，排班 iframe 和其他资源版本保持原样。
- 验证 AC13／AC14：复跑既有审核处理台、工作桥、工作台与父导航检查；用实际渲染器核对两身份、类型与状态切换、长正文和空记录。比对改动前后的函数与文件指纹，确认审核保存／权限、两个工作台及排班均不变。浏览器不可用时保留视觉复核限制。


审核 UI 验证结果：19 个 JavaScript 文件语法检查通过；现有审核、工作桥、超管工作台、父导航和容器共 165 项通过。实际工作脚本的内存 VM 核对两种管理身份、类型／状态点击、留言全文、长正文转义、历史只读提示和分类驳回理由，并解析审核样式，共 193 项断言通过，131 条样式规则均受审核作用域限定。文件指纹仅 5 个运行文件改变，其中 3 个仅更新资源版本；management.js 在审核渲染／表单之外的内容指纹完全一致，两个工作台、共享业务和排班文件未变。父入口与 4 个关键审核资源均 HTTP 200 并含 v17 内容。已请求打开新版审核地址；浏览器自动化仍因 trusted Node process exited unexpectedly 不可用，未完成截图与实际尺寸视觉验收。


## 2026-10-09 胶囊导航角标局部实施

- 在父壳 app.js 新增只读 navigationCounts，依现有 work.management、draft.status、leave、schedule.publishedVersion／published／people 和 readScheduleVersion／readLeaveRevision 计算。工作台遵循现有角色总览；社干总览计审核加站内事务，超管以正式缺岗替代请假待补（无正式班表则沿用待补），不相加重复项。
- renderCapsuleNavigation 复用原 navItems／navSection，图标包入 portal-nav-icon，非零加入 portal-nav-badge；展示封顶 99+，按钮 aria-label 使用完整数值。HTML 不变时不重建，保留原事件与选中态。仅 portal-shell.css 的胶囊专属类增加位置、红底、白字和中性描边，图标／触控区域和其他布局不变。
- renderNavigation 调用该函数；已校验来源的 changed、ready 消息及当前共享存储 key 的 storage 事件刷新角标，仍用原保存后通知及角色切换，不写入样例、不传输业务明文。现有两 iframe 资源版本不动，仅父壳脚本／样式入口缓存更新为 nav-badges-v18。
- 验证：实际父壳 VM 检查三种角色、合并计数、通过审核减少、事务与缺岗、失败不变、个人已读和确认、0／99+、非法消息、有效存储 key、未初始化数据；复跑父导航／容器与现有审核／工作桥。比对文件指纹只允许父壳 app.js、portal-shell.css、index.html 和本增量文档变化。浏览器不可用时明确视觉验收限制。


本增量 spec／plan 经单轮 Explore 审查通过，无 critical／major；独立实现复核通过。父导航、容器、审核、工作桥及超管工作台现有 165 项通过，新增一次性父壳 VM 核对 44 项通过，覆盖三身份计数、真实保存后重算、重复通知、保存失败不变、0／99+、原导航契约、成员未读状态与可排确认、非法来源及 QA key 隔离。父脚本语法和 CSS 解析通过；运行文件指纹仅 app.js、portal-shell.css、index.html 改变，子页与共享业务文件未变。父入口及 v18 脚本／样式均 HTTP 200。沿用原 schedule／leave 读状态规则，不扩展同场景或 mine 清读行为。CUA 仍因 trusted Node process exited unexpectedly 无法截图验收；角标范围和 320／375 像素尺寸已静态复核。


### 2026-10-09 角标溢出修复（AC15）

按用户最新指令撤回浅色导航调整，保留现有导航配色、图标、触区和待办计数。仅在 portal-shell.css 将角标从 top:-7px/right:-12px 向图标内侧收至 top:-2px/right:-6px，限制最大宽度 30px，并在导航按钮限定溢出边界；原 18px 高度与红底白字保持。index.html 只更新样式缓存至 badge-inset-v19，父脚本和子页资源不变。核对 320／375 像素、4／5 项导航及 1／99／99+ 的静态边界，复跑现有导航与容器检查；不新增业务或改变任何页面。此为已批准 F14／AC15 的缺陷修复。

溢出修复验证：导航 30 项、容器 43 项通过；CSS 解析和 24 组手机宽度／导航项数／角标宽度的边界计算通过。反向还原两处 CSS 后指纹与原文件一致，导航配色及其他样式未变；父业务脚本、store 与 work integration 指纹未变。独立只读审查确认定位在按钮内并保留 99+。入口与 v19 样式 HTTP 200。CUA 内核仍因 Windows sandbox helper_unknown_error 退出，未完成截图验收。


## 2026-10-09 卡片与更多局部实施

- 三种工作台仅在 work/integrated-renderers.js 的站员首页、work/management.js 的社干首页、work/integration.js 的超管首页欢迎模板加入共同展示类，站员根节点加 member-dashboard。新增 work/workbench-cards.css，并在 work/index.html 最后加载；所有样式受 member-dashboard／manager-dashboard／super-dashboard 根限定，统一欢迎卡、头像、主卡留白及次级卡片，旧业务计算、入口数据属性和事件不动。
- 父壳 app.js 仅修改 entry／group／renderMore 展示，原三角色入口数组与路由不变；身份用姓名／角色标签／头像／简短说明，列表添加现有线性 SVG（无需资产或依赖）。portal-shell.css 仅在 more-content 范围下整理字号、浅色身份卡、分组列表、图标和间距。
- 角标去除 border，portal-nav-icon 改成横向独立图标／数字两格，角标处在右侧顶端，图标 22px、角标高 14px，整体最大宽度 48px；保留原 54px 触区与选中背景。数字使用现有 99+，不改 navigationCounts。
- 更新父壳、工作 iframe、对应内容脚本／新增样式缓存为 cards-more-v20，排班及审核样式版本不变。验证三角色真实渲染、原入口集合和数据不变；复跑父导航、容器、工作桥、超管和审核检查，解析 CSS 并静态核对角标独立几何／窄屏。记录浏览器截图工具不可用时的视觉验收限制。

<!-- review-fix: CARDS-MORE-P6-1 -->
共同卡片样式限定到三个工作台根，便于统一展示且防止公共类影响审核、稿件和排班；未采用全局 card/tile 覆写。角标选择同一图标容器内的独立两格，给 SVG 和数字各自保留真实空间；此前绝对叠加因外偏移与白色描边遮挡图形，故不再使用覆盖定位。上述方案覆盖 AC17／AC18，可单独回退展示样式，不触及业务状态。

本增量单轮 spec 审查通过，plan 的 1 个文档理由缺口已按 CARDS-MORE-P6-1 补充，无未消化 critical／major；两个独立实现审查通过。19 个 JS 语法、两个修改 CSS 解析通过；现有父导航、容器、工作桥、超管及审核共 165 项通过，三角色实际渲染／更多角色与入口／只读／53 条局部 CSS／角标几何共 138 项断言通过。所有原工作台 data-* 动作与更多 data-route 集合逐角色一致，四个脚本在显示块之外的指纹一致；7 个运行文件变化，加 1 个局部样式文件，其他页面及共享业务文件未变。入口、父脚本与样式、工作 iframe 和 4 个工作台资源共 8 个请求均 HTTP 200，内容包含 v20。CUA 仍因 Windows sandbox helper_unknown_error 退出，尚未完成浏览器截图验收，尺寸结论为 CSS 几何核对。


### 2026-10-09 按截图改为背景与浮叠卡片

沿用本轮展示范围：只修改 workbench-cards.css 欢迎区域，负横向外边距抵消嵌入内容留白，以中性浅色铺满顶部；留出底部空间，站员主卡上叠 24px，社干／超管周信息进入背景留白后主卡上叠约 22px。窄屏规则保留底部空间，避免覆盖简介。更多 renderMore 删除 more-head，身份区域去边框／圆角作全宽背景；第一 more-group 整体成为白卡向上叠 20px，标题和列表同卡，其余分组保持独立白卡。角标继续独立横向空间以免挡图，取消中间间隙并上移 5px（窄屏 4px），图标保持 22／20px，角标无白圈、原触区不变。资源缓存更新为 backdrop-v21；其他渲染器／业务／入口数组不改。


本次纠正验证：父页面 JavaScript 语法及两份 CSS 解析通过；既有导航 30 项、预览容器 43 项、工作台桥接 34 项、超管工作台 10 项，共 117 项通过。三种身份的更多页实渲染确认标题已删除、原入口与存储不变；独立只读复核确认三角色欢迎文字不被浮叠卡片遮挡、窄屏留白保持，角标无白环并保留独立横向空间。运行文件指纹仅 5 个目标文件改变、无新增；父页面、脚本、样式与工作台资源 5 个 HTTP 请求均为 200 且含 backdrop-v21 当前内容。浏览器自动化因既有 Windows sandbox helper_unknown_error 不可用，本次未完成截图视觉验收。
