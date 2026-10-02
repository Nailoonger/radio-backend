# 招新模块技术设计

状态：用户已授权实施，功能代码与本地验证完成（2026-10-02），尚未部署。依据已批准的 spec.md；云环境权限、事务与真机显示需上线前实测。

## 架构与范围

小程序当前 requestMode 为 cloud，实际后端为 cloud/cloudfunctions/api，故新增功能以云函数及云数据库为主。公开招新页面不调用学生鉴权；后台复用现有管理员 JWT 与角色校验。用户已要求直接实现，部署作为后续独立操作。

管理后台采用现有 admin-web 的云端请求通道，新增招新页面供完整表单配置与审核。现有小程序管理端本期不新增招新管理页面，避免两个配置界面重复建设。修改 admin-web 只增加招新视图、导航和路由，不改原模块、部署及直连配置。若 Web 后台仍在 direct 模式，招新导航显示云端通道未启用提示，不能误调用不存在的 Express 招新接口；开始实现前验证后台云通道在实际环境可用。

依赖顺序：页面 → 请求门面 → 路由与限流/鉴权 → recruitmentService → recruitmentStore → 云数据库。formValidator 与 codeService 是服务依赖，不反向调用页面或控制器。云端读写必须经服务端，新增集合禁止客户端直接读取。

## 核心数据结构

所有时间存 UTC 毫秒整数，对外 ISO 时间带时区，小程序显示北京时间；复用 cloud/cloudfunctions/api 的现有北京时间工具（实施时确认实际文件位置），不得裸算本地日周。文本长度按 Unicode 字符数验证，界面和服务端使用同一规则。

| 集合 | 核心字段及规则 |
|---|---|
| recruitment_batch | _id 随机标识；title 字符串 1～100 字；intro 1～10000 字；opensAt/closesAt 毫秒整数；publishedAt/resultPublishedAt/archivedAt 可空；questions 数组；version 整数从 1 递增 |
| recruitment_application | _id 随机标识；batchId；name/studentNo/grade/className 遵循 spec 长度；answers 对象；progress=submitted/interview/withdrawn；decision=null/accepted/rejected；internalNote 最多 2000 字；publicNote 最多 2000 字；interview={at,location,note} 可空，地点最多 200 字、说明最多 2000 字；codeHash；codeCipher；submissionKeyHash；payloadHash；version；createdAt/updatedAt |
| recruitment_unique | 固定 _id 为批次与学号的摘要，applicationId；撤回保留占用，改学号原子迁移占用 |
| recruitment_code | _id=codeHash，applicationId；确保全局查询码唯一，管理员列表不返回码 |
| recruitment_control | 固定 _id=global，保存全部已发布未结束的窗口；发布/改时间时事务维护，防并发发布重叠窗口 |
| recruitment_rate | _id=来源摘要+动作+分钟，count、expiresAt；原子计数；过期记录定期清理 |

问题结构：{id,type,title,required,options}，id 批次内稳定且唯一；type 为 text/textarea/single/multiple，排序取数组顺序；选项 {id,label} 使用稳定 id，答案为字符串或选项 id 数组，拒绝未知题目、未知选项及重复选择。空可选题规范为缺少键。问题最多 20 题，其余上限严格按 spec。

## 查询码与安全重试

codeService 使用服务端密码学随机源，从 32 个不易混淆字符中生成 16 位码（80 位随机量），统一大写、去首尾空白后摘要查询。服务端摘要索引与认证加密后的码同时保存，明文只在首次成功及同一提交的安全重试响应返回。查询码不放 URL、导航参数、日志或管理员列表中。

表单首次提交生成至少 128 位随机 submissionKey，并在设备缓存至成功。服务端保存摘要和规范化 payloadHash。同一 key、相同内容的重试返回原记录及查询码，即使重试时已截止；同 key 不同内容返回冲突。不同 key 的同学号提交只提示重复，不返回原记录。同次重试先查已有结果，再验证新建窗口。成功后客户端删重试凭证，提供查询码复制，不自动长期保存查询码。

码加密密钥由云端环境配置注入，不进入仓库；实施前验证环境支持。解密失败不得生成替代码。codeHash 碰撞在创建事务中重生成重试（最多 3 次）；耗尽返回失败，不创建半份报名。修改/撤回 body 必须携带 queryCode；请求门面关闭该模块请求及响应正文的调试日志。查询页仅内存持有码，退出清理。

## 事务与并发

现有 lib/db.js 不提供跨文档事务，本模块新增 recruitmentStore 专用事务封装，使用云数据库服务端事务能力，并在实施首步以真实开发环境验证，不用先查后写代替事务。不修改原有模块的数据原语。

新报名在同一事务中校验批次版本、公开窗口，建立学号唯一占用、查询码唯一占用及报名记录，更新批次 version，使报名与配置并发产生冲突并重试。submissionKey 唯一占用也在事务中建立（使用 recruitment_unique 的 submit: 前缀）。改学号原子建立新占用、释放旧占用和修改记录。修改/撤回/重提交同时检查 batch.version 和 application.version，冲突重试最多 3 次，再返回 40904。

后台审核必须在截止后执行，每次改决定/面试事务读取并更新批次 version，防止与发布竞争。发布结果不一次写全体报名：维护批次 unresolvedCount，在新建时 +1、撤回时 -1、重新提交时 +1、首次决定时 -1；结果修正不重复扣减。发布事务验证截止、已发布招新且 unresolvedCount=0 后只写 resultPublishedAt。所有决定写操作读写同一批次文档，发布后拒绝修改。归档只更新 archivedAt。unresolvedCount 需增补为批次非负整数字段，由事务维护；发布前校验计数不变量，异常时拒绝发布，禁止猜测修复。

## 对外接口

<!-- review-fix: ISSUE-1 -->
服务端转换断言：submitted 只能直接决定 rejected；interview 可决定 accepted/rejected；withdrawn 拒绝审核决定、备注和面试写入。安排面试仅允许 submitted 或 interview，且已有决定的记录不可通过面试接口偷偷改变决定；须先修正审核，未发布时可在原 progress 下修正允许的决定，不能把 submitted 直接改为 accepted。审核已提交报名填写备注可不设置决定；全部审核和面试写操作在截止后、结果发布前执行。对应增加完整状态转换和越权直调测试。

<!-- review-fix: ISSUE-2 -->
归档事务先验证超管权限、请求版本及 resultPublishedAt 非空；未发布结果返回 40906。已归档的重复请求在校验超管后幂等返回当前批次 DTO，不再次更新时间。新增未发布批次归档失败及重复归档不影响查询用例。

路径是请求门面的相对路径，不带 /api。成功沿用 {code:0,data}；全部错误沿用统一错误体。后台分页 page 默认 1、pageSize 默认 20、最大 100，返回 {items,total,page,pageSize}。

| 方法与路径 | 入参 | 出参/含义 |
|---|---|---|
| GET /user/recruitment/current | 无 | {batch:null} 或公开批次 DTO，含问题及窗口状态；无开放批次时返回最新已发布未归档批次 |
| POST /user/recruitment/apply | batchId,submissionKey,name,studentNo,grade,className,answers | {queryCode,application:publicDTO}；创建或安全重试 |
| POST /user/recruitment/query | queryCode | publicDTO；无学生鉴权 |
| PUT /user/recruitment/application | queryCode,version,固定字段,answers | 更新后的 publicDTO |
| POST /user/recruitment/withdraw | queryCode,version | 已撤回 publicDTO |
| POST /user/recruitment/resubmit | queryCode,version,固定字段,answers | 原记录重新提交 publicDTO |
| GET /admin/recruitment/batches | page,pageSize,archived 可选 | 批次分页，普通管理员可读 |
| POST /admin/recruitment/batches | title,intro,opensAt,closesAt,questions | 草稿批次 DTO，超管 |
| GET /admin/recruitment/batches/:id | 无 | 批次 DTO，普通管理员可读 |
| PUT /admin/recruitment/batches/:id | version,允许修改的字段 | 更新后的批次 DTO，超管 |
| POST /admin/recruitment/batches/:id/publish | version | 发布后的批次 DTO，超管 |
| POST /admin/recruitment/batches/:id/results | version | 结果已发布批次 DTO，超管 |
| POST /admin/recruitment/batches/:id/archive | version | 已归档批次 DTO，超管 |
| GET /admin/recruitment/applications | batchId,page,pageSize,grade,status 可选 | 报名分页；status 为五种后台展示状态 |
| GET /admin/recruitment/applications/:id | 无 | adminDTO（无查询码及提交凭证） |
| PUT /admin/recruitment/applications/:id/review | version,decision 可选,internalNote 可选,publicNote 可选 | adminDTO；普通管理员，decision 为 accepted/rejected/null（null 明确撤销拟定结果） |
| PUT /admin/recruitment/applications/:id/interview | version,at,location,note | adminDTO，普通管理员；必须时间、地点齐全 |

publicDTO 仅返回报名固定信息、答案、batch 标题及题目、公开 progress、面试安排、canEdit/version；发布前 decision/publicNote 不返回，发布后才返回结果。已撤回一直显示已撤回，不显示录取结果；公开 DTO 不包含任何哈希、内部备注、数据库凭证或查询码。待面试保存录取决定后公开 progress 仍是 interview。结果发布后统一投影 accepted/rejected。

错误约定：40001 校验或未知字段；40301 管理权限；40401 无公开批次/后台记录；40404 无效查询码（不存在的码统一此文案）；40910 版本/提交凭证冲突；40911 同批次重复学号；40304 窗口关闭；40912 状态不允许/仍有未决定报名；42901 超限。已核对旧 40904/40906 为点歌保留码，招新使用独立错误常量，避免改变既有错误码同步自检；不返回 401 表示查询码无效，避免清学生登录。

## 限流来源

HTTP 通道以可信网关来源地址为键，忽略请求体伪造地址；原生云调用没有可靠客户端 IP 时以云平台注入 OPENID 为来源键，不把它作为报名身份或登录要求。因此云通道限流以调用者计，与 HTTP 按 IP 的限流不同，这是 spec N2 在双通道下的明确适配，需用户知悉。没有可信来源的调用拒绝而非共用全局键。配置提交 5/查询 20/修改撤回重提交合计 10 次每分钟，安全重试计入提交限制；窗口为 UTC 分钟固定窗口，计数存数据库，不用进程内计数。

## 页面设计与文件组织

- miniprogram/pages/mySubmit/mySubmit.wxml、.js、.wxss：将加入我们置于登录区之外，保持原投稿列表逻辑。
- miniprogram/pages/recruitment/index.{js,json,wxml,wxss}：公开介绍、限定年级提示、报名与查询两入口、未开放/截止状态。
- miniprogram/pages/recruitment-form/index.{js,json,wxml,wxss}：动态四种题型与固定必填信息，复用于查询后的编辑及重新提交。
- miniprogram/pages/recruitment-result/index.{js,json,wxml,wxss}：查询码输入、查询结果、面试、结果、修改撤回；提交成功面板展示复制码。码在页面通信中内存传递，禁止拼 URL。
- miniprogram/app.json：注册三页；miniprogram/utils/recruitment.js：API、临时重试凭证、内存查询上下文；utils/request.js 增加明确的敏感日志抑制选项，默认行为兼容既有调用。
- admin-web/src/views/Recruitment.vue：批次列表、配置/问题编辑、报名筛选和详情抽屉、面试、结果发布、归档；router/index.js、layouts/MainLayout.vue 添加招新管理。api/recruitment.js 复用现有云 HTTP 请求门面并校验模式。
- cloud/cloudfunctions/api/services/recruitment.js：窗口、状态机、公开投影与业务流程；recruitmentForm.js：验证；recruitmentCode.js：码及凭证；recruitmentStore.js：事务与限流数据访问。
- cloud/cloudfunctions/api/handlers/user/recruitment.js、handlers/admin/recruitment.js：控制器；router.js、handlers/index.js 登记路由，字面量优先；lib/response.js 扩充错误约定。
- cloud/scripts/init-recruitment.js：幂等初始化集合及索引，仅增新集合；scripts/test-recruitment.js：内存 harness 验证；原 harness 新增事务模拟与冲突用例，不假定旧 fake DB 能证明真库事务。
- docs/admin-permissions.md：补充权限；cloud/README.md：集合、密钥配置和验证步骤；cloud/scripts/sync.js 使用现有打包流程生成 miniprogram/cloudfunctions/api，不手改产物。

## 技术决策与限制

| 决策 | 理由与备选 |
|---|---|
| 云后端为本期唯一新增后端 | 符合实际运行通道；双写 Express 会产生两份招新数据，暂不实施 |
| 随机码持有即授权 | 用户已选择；学号查询会泄露信息，学生账号前置违反公开报名 |
| 摘要索引＋码加密 | 支持安全重试又减少数据库明文凭证；仅存摘要无法补回首次响应，明文保存增加泄露面 |
| 批次单点发布标记 | 原子切换所有人可见性；逐条发布会产生半发布状态 |
| 完整后台首先使用 Web | 现有表单组件适合题目配置；本期同时建设移动管理页面扩大范围 |
| 专用事务封装 | 避免并发重复及半记录；现有唯一键预约不能独自保证多文档原子性 |

技术限制：查询码丢失无自助找回；未验证学生身份，其他人可冒填学号并抢占报名，不能视作身份认证；HTTP 共享校园地址会共用限流；云事务及密钥配置必须开发环境验证。每批次写入同一控制文档的并发吞吐需实测，高争用时限次重试并提示重试，不静默放开规则。

审查记录：独立审查 1 次，发现 major 2 项，已修订审核转换与归档条件 2 处；无未处理 critical 或 major。云调用按可信 OPENID 限流的适配及仅新增云后端属于技术设计决定，与原 spec 的 IP 表述和双通道范围差异已在本文明确，正式实施前确认运行渠道。

## 开发与验收顺序

1. 核对云后台通道、事务、可信限流来源及错误码；验证安全重试，再开发公开报名与查询（F1～F7、AC1～AC7）。
2. 开发后台配置、审核与面试及权限（F2/F4/F8/F9/F11、AC2/4/8/10）。
3. 开发结果统一发布与归档，完成限流、视觉及全流程验证（F10、N1～N4、AC9/11/12）。

有意义的验证包括并发同学号、重复响应丢失、学号修改竞争、配置锁定、发布与审核竞争、无效码、跨批次泄露、直接越权调用。云 harness 与真实开发环境各验证事务与公开投影；跑 cloud/scripts/regression.js 源码及产物回归、小程序全量 node --check、admin-web 本地 build，并按仓库要求跑 npx jest。既有微信凭据失败单独记录，不算招新验收通过。规划阶段不执行这些业务测试，也不部署。
