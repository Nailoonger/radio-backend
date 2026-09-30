# 全项目 Git 版本管理与云端自动发布 Plan

## 架构概览

保留 Nailoonger/radio-backend 单仓库与 master 生产分支，由 GitHub Actions 统一完成校验和发布。生产发布只有一处触发器，已有云控制台的 Git 自动发布在接通新流程时关闭。

<!-- review-fix: R1-P1-01 -->
工作流分为 verify（最长 20 分钟）和 publish（最长 10 分钟）两个顺序执行的 job。总执行预算为 30 分钟，不包括 GitHub 排队等待时间。PR 只有 verify；master 推送与手动触发先判断校验范围，通过后才允许 publish。verify 只有 GitHub 只读权限、无部署密钥，publish 才注入腾讯云凭据。

校验范围：文档/设计独立变化仅执行发布政策测试；小程序独立变化追加源码语法检查；网页、云函数或发布机制变化执行全部最低发布校验。master 判断是否需要全部校验时，也读取两端最后成功 GitHub Deployment 与当前提交比较，覆盖曾被替换的等待任务；PR 按合并基线比较，手动 check/publish 均执行全部校验。发布锁内仍重新比较成功基线，verify 的判断不能替代生产最终判断。

首次接通后用户手动选择 publish 初始化两个组件的发布基线。后续自动发布在固定生产环境并发锁内，对照网页、网关各自上次成功 GitHub Deployment 的提交比较变更。不能只比较推送前后的提交，否则被取消的等待任务中的改动会漏发。没有基线的自动任务明确提示先初始化，不修改生产环境。

## 文件组织与模块

<!-- review-fix: R1-P9-01 -->

| 文件 | 职责 |
|---|---|
| `.github/workflows/cloud-release.yml` | PR/master/手动校验、产物交接、独占生产发布、步骤权限与超时 |
| `scripts/release/detect.js`、`github.js`、`github.test.js` | 校验范围、只读成功基线查询与 GitHub 发布记录接口 |
| `scripts/release/package.json`、`package-lock.json` | 固定官方管理 SDK 版本为 5.9.0，供发布脚本使用 |
| `scripts/release/verify.js` | 小程序 JS 语法、发布控制测试、云函数重新打包及双轮回归、Vue 绑定检查、网页构建、产物依赖检查 |
| `scripts/release/policy.js`、`policy.test.js` | 提交/路径识别、缺配置处理、稳定配置快照、发布顺序、失败停止的纯逻辑与回归 |
| `scripts/release/publish.js`、`publish.test.js` | GitHub 组件 Deployment、SDK 代码更新与静态文件上传、只读健康检查；依赖注入支持假平台测试 |
| `scripts/release/cloud.js`、`cloud.test.js` | 官方 SDK 代码更新、配置指纹、网关与网页只读验收适配 |
| `cloud/cloudfunctions/api/package-lock.json` | 锁定运行时依赖；构建到部署产物时与清单一起复制 |
| `cloud/scripts/sync.js`、`test-bundle.js`、`selfcheck.js` | 单文件打包时复制依赖锁，统一四个部署文件的完整性断言；依赖安装后的 node_modules 不作为陈旧源码目录 |
| `docs/git-release.md` | 新电脑拉仓库、一次性 Secrets/Variables 配置、首次启用、回退提交、失败排查和现有测试基线 |
| `.gitignore`、`.gitattributes` | 密钥/运行数据/产物排除、两个正式源码例外、Linux 脚本换行 |

F1/F2 的 Git 整理：将 `_kit.js`、`_people.js` 精确放行并跟踪。停止跟踪 SQL 数据备份、uploads、微信私人配置、测试输出文本、生成的 miniprogram/cloudfunctions/api 镜像；仅移除索引，保留本地副本。新增设计 HTML/CSS/JS 及其引用资源纳入仓库；现有设计资料保留，不将无引用截图与临时导出包作为新源码加入。

## 核心接口与数据结构

### 校验入口

`verify(root, revision, apiUrl)`：Node.js 20，读取仓库源码和已安装的锁定依赖，无生产凭据。输出 `admin-web/dist`、`miniprogram/cloudfunctions/api` 产物及公开发布元数据；失败返回非零状态。PR 构建使用公开的测试地址；生产构建要求明确提供现有云 API URL。运行子进程时移除 JWT_SECRET、WECHAT_SECRET、腾讯云凭据，防止可选联调脚本连接生产。

### 变更判定

`needsRelease(component, baseRevision, headRevision, changedPaths)`：component 为 web 或 api；基线、目标为完整 Git SHA。网页范围为 admin-web 业务/构建文件；云函数范围为 cloud/cloudfunctions/api、打包器。发布机制及其依赖文件变化影响两个组件。文档、设计、旧 src/sql/deploy 不属于自动发布路径。若两端无基线，仅显式手动初始化允许发布；缺少基线的普通自动推送失败并提示初始化。

### GitHub 发布记录

`lastSuccess(component)` 从当前仓库读取对应环境 `radio-production-web` / `radio-production-api` 中，本流程 task 为 deploy 的成功记录，分页查询。记录 payload 包含 `managedBy: radio-release-v1`、component 与 revision；忽略其他部署入口的记录。

创建记录使用 `ref=完整提交`、`auto_merge=false`、`required_contexts=[]`、`production_environment=true`。状态为 in_progress、success 或 failure，附当前 Actions 日志链接；仅发布成功后记 success。网页失败而云函数已成功时，保留云函数成功基线，下一次仅补发网页。状态更新失败必须显式报错，不用丢失的记录推断发布成功。

### 云函数更新

通过官方 `@cloudbase/manager-node@5.9.0` 的 `commonService().call({Action:'GetFunction',Param:{EnvId,Namespace,FunctionName:'api',ShowCode:'FALSE'}})` 读取原始线上信息，稳定排序后仅在内存保存配置指纹。字段包括 Handler、Runtime、MemorySize、Timeout、Environment、Type、VpcConfig、Role、Layers、InstallDependency 与 Triggers，并保留其他已返回的运行配置字段；排除代码、状态、时间和 RequestId。使用原始读取避免高层接口把 VPC ID 替换成易变的描述对象。

`functions.updateFunctionCode({func, functionPath, deployMode:'cos'})` 只更新代码，不调用创建、覆盖配置或触发器接口。func 的 name 固定 api，handler/runtime/installDependency 使用线上原值，isWaitInstall=true。产物提前安装锁定的生产依赖；线上原先启用云端安装时 SDK 自动忽略 node_modules，原先关闭时上传完整依赖。两种情况都保留原安装开关。

首次平台验收修正：触发器保护按线上实际列表执行，允许完整的空列表或不同任务名称。校验返回元数据的完整性，并比较部署前后所有触发器字段；不能把源码 config.json 中的预设任务名作为现有环境的部署前提，也不能在代码发布时自动补建任务。

更新前后通过 `env.describeHttpServiceRoute({EnvId,Offset,Limit})` 分页读取域名/路由，比较现有 `/api` 配置；更新后等待 Active 状态，并使用现有网关入口的 POST 信封调用 `/health`，要求业务 code=0、dbReady=true、jwtReady=true。检查配置差异时只输出字段名称，绝不输出 Environment 值。更新接口返回的 SCFErrorCode 也必须检查；任何失败阻止网页发布。

### 网页更新

调用 `hosting.getWebsiteConfig()` 保存索引/错误页/路由配置指纹；要求现有 SPA 回退规则存在。使用 `hosting.uploadFiles({localPath,cloudPath:'',entryFiles:['index.html'],verify:true,safe:true,prune:false})`，先上传资源，入口文件最后上传，不删除现有资源。SDK 对上传失败执行文件回退。元数据公开记录提交，不包含凭据。上传后比较网站配置，读取已上传的入口与元数据验证提交及文件内容；原网址与子页只读检查用于确认现有路由仍可用。

### 发布入口与错误约定

`publish({revision,manual,github,cloud,files,logger})` 按 api → 健康检查 → web 顺序执行；平台依赖可替换成假实现。缺少 Secrets/Variables、过时自动任务、未知线上配置、平台错误、健康检查失败均有独立可读原因；生产错误正文不输出，记录安全的错误类别和 RequestId。过时自动任务跳过全部生产写入，并给出当前 master 与候选 SHA。

部署前在独占锁内重新读取远端 master，必须等于当前候选 SHA。锁为 `radio-production`，cancel-in-progress=false；新推送可以替换等待任务，下一条任务按各组件最后成功基线重新比较，因此不会漏发。主动回退采用 master 上的新提交，而非绕过 SHA 校验发布旧提交。

## 工作流数据流

源码检出 → 判断校验范围 → 发布政策测试 → 按范围安装依赖与执行小程序检查。需要最低发布校验时：安装根、管理后台、云函数及发布工具的锁定依赖 → fresh bundle → 源码与产物双轮云回归 → Vue 绑定检查与 cloud 模式构建 → 上传当次产物。

master 发布 job 获取同一 run 的产物和源码 → 获取生产锁 → 检查候选仍是 master → 校验必需配置 → 查询两端成功基线 → 判断组件变更 → 云函数代码更新及配置/健康检查 → 网页资源与入口上传及配置检查 → 分别写成功记录与提交摘要。PR 和手动 check 模式在产物验证后结束。

部署 Secrets 为 TCB_SECRET_ID、TCB_SECRET_KEY；非敏感 Variables 为 TCB_ENV_ID、VITE_CLOUD_API_URL、ADMIN_WEB_URL。GitHub 的 GITHUB_TOKEN 自动提供，校验 job 只有 contents:read 和 deployments:read，发布 job 只有 contents:read 和 deployments:write。可选代码保护密钥仅在现有函数确实开启代码加密时提供 TCB_CODE_SECRET。不将 JWT 或微信密钥搬进发布流水线。

## 技术决策

| 决策 | 选择与理由 | 未采用的备选 |
|---|---|---|
| 发布入口 | GitHub Actions 统一校验、记录、顺序与锁 | 云控制台分别配置自动发布，容易重复和顺序不一致 |
| 云函数方式 | SDK 代码更新，原运行配置显式保持 | 强制部署覆盖配置与触发器，违反 F5 |
| 发布基线 | 各组件最后成功记录 | 单次推送前后差异，会漏掉被替换的等待任务 |
| 静态文件 | 资源先行、入口最后、不清旧资源 | 整站删除再上传，会导致旧浏览器资源失效 |
| 回退 | 新增回退提交后正常发布 | 直接发布历史 SHA，会绕过过时任务保护 |
| 小程序 | 源码检查与微信正常发布 | 自动正式上线不在本次范围 |

## 验证与外部验收

本地验证纯发布政策、平台错误/缺项/顺序/配置差异/网页部分失败的模拟测试；运行云函数双轮回归、Vue 构建、小程序语法与归档后端 Jest，并报告既有失败。暂存完成后导出只含索引文件的独立副本，重新安装锁定依赖并复跑发布校验，证明不依赖本机密钥或旧产物。

用户在 GitHub 完成 Secrets/Variables 后，第一次手动 check 验证构建，再手动 publish 初始化并核验原网站与 API。凭据尚未配置时，本地验证只确认发布流程实现，不能宣称线上自动发布已经启用。外部验收对应 AC5/AC6/AC8/AC9 的真实云平台行为，其他 AC 通过本地模拟和独立副本验证。
