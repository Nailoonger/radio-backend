# 菁悠广播站 · 项目长期备忘

> **只留：铁律 + 固定操作顺序 + 反复踩的坑。**
> 细则位置：`docs/`（song-protocol / student-account / admin-permissions）、`cloud/README.md` + `cloud/docs/*`、
> `.workbuddy/memory/PROJECT-NOTES.md`（云开发迁移细则 / 点歌体系 / admin-web 视觉参数 / 学生账号 / 已废弃
> —— **改对应模块前读那一节**）、各 skill。真机收尾清单：`cloud/docs/final-cutover.md`。
> 口径：「收歌」已全站改名「点播」（只改展示名，常量仍 `APPLICATION`）。

## 铁律
- **只做加法**：原 Express `src/` + `admin-web/` + Docker 链路一行不删，保留 `requestMode: 'direct'|'cloud'` 开关
  （陛下：「不要删除原来的，以防我想换回来」）。
- **绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉改动**先出静态 HTML 预览并标版本号（v1/v2…），点头前不写业务代码**；版本只增不删。被否或含糊 → 先问清形态。
- ⚠️⚠️ **设计不许用通用范式**（2026-09-29 被当面否：「不要去找别人做好的方案，你自己做」）：
  深色头+白卡 / 全屏深色沉浸 / 极简白这类"换给别的 App 也成立"的一律不算。要**从项目自身的业务隐喻长出来**
  （已用：调频刻度、录音电平、收听证钢印、骑缝孔、点唱机唱针）。
- ✅ **登录页是唯一获批突破配色的页面**（2026-09-30 陛下开口）：可不用深色卡、可不守「#0066CC / 无渐变 / 无彩色投影」。
  v6 走奶油 #FFF8EF + 橘红 #FF6B35 暖色盘。其余页面仍守设计系统。
- 提交身份用全局 `Nailoonger <1493586497@qq.com>`，不写仓库级 user.*。

## 云开发迁移（`cloud/`）
> 细则（阶段 8 三约束三陷阱 / 阶段 9 httpBridge 与门面 / 两处源实现瑕疵 / 回归速查）见 `PROJECT-NOTES.md`。
- 进度：**阶段 0–9 全部完成**；回归 **3115 项 / 0 失败**（源码 15 套件 + 产物 13 套件）；产物 50 模块 / 395.2 KB。
- **架构**：源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。
  ⚠️⚠️ **Windows CLI 传子目录必坏**（`\` 进压缩包条目名 → 云端扁平化，`require('./lib/x')` 必败）
  → `sync.js` 把 50 模块打成**单文件 index.js**，只传根文件 + `config.json`。⇒ `handlers/index.js` 必须是**静态注册表**。
- **部署**：`node cloud/scripts/deploy-cloud.js`（默认只打印）→ 手动
  `cli.bat cloud functions deploy --env <env> --names api --project <miniprogram> -r` → **等 1~2 分钟**再验。
- **口径**：业务查询一律用**数字 `id`**（`parseId`）；4 张表用业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；
  字段名一律**驼峰**；⚠️ `insertOne` 之后改这行必须用**返回的 `_id`**。

## 真机收尾（陛下动手，顺序不能乱）
> 清单 `cloud/docs/final-cutover.md`。**①–⑦ 完成**；**⑧ 小程序切 cloud：体验版真机验证通过、待发正式版**。
> ⑦ 实测：8 个管理端接口全绿（含真返回 xlsx）；真实 Chromium 跨域直连成功、`/dashboard` 渲染出云端数据。
> ⚠️⚠️ **⑧ 学生侧「别人用不了」的真正卡点**：`miniprogram/app.js` 的 `requestMode` 一直是 `'direct'`
>    （`baseURL` 还是 `http://IP`）⇒ 微信正式版只允许 **HTTPS + 已备案域名** ⇒ 必然 `url not in domain list`
>    —— 就是当初启动云开发迁移的那个报错，**开关一直没拨**。已改 `'cloud'`（`callFunction` 不过域名校验）。
>    **只改代码不重新上传＝没生效**；且**必须用微信客户端验证**（开发者工具会跳过域名校验，工具里通≠手机上通）。
>    ⇒ **学生走小程序（改一行、免备案）／老师走 admin-web（网页，IP 即可）＝两条独立的线，别混谈。**
>    ✅ 2026-09-30 真机验证：体验版**不再报错、可正常登录**，且**无需再开「不校验合法域名」**；
>    另学生端 13 个只读接口云端全绿。**待发正式版**（体验版只有体验成员可见，学生仍跑旧版）。
>    ⚠️⚠️ **`miniprogram/app.js:65-69` 有个 localStorage 覆盖开关**：`wx.getStorageSync('debug_requestMode')`
>    若为 `'direct'`/`'cloud'` 会**盖掉 `globalData.requestMode`** —— 排查「通道不对」必先查它
>    （清：`wx.removeStorageSync('debug_requestMode')`）。另：小程序**页面栈缓存**会把上次输错的
>    账号/密码/错误条留在页面上，重置密码后必须在原页重输或退出重进，别直接按登录。
>    ⚠️ 切云后学生侧**完全依赖云开发环境**（无服务器兜底）：本环境「校园版个人版前 6 个月免费」，
>    到期/超额＝全站突然不可用；HTTP 访问服务默认域名也要到期点「续期」。
> ✅ **`JWT_SECRET` 已补配并验证通过**（2026-09-30，陛下在 云函数 `api` → 配置 → 高级配置 → 环境变量 加行）：
>    用 `cloud/scripts/verify-jwt-secret.js` 复验 —— 兜底值自签 → `40101`（已失效）、新值自签 → `code:0` 带真实数据（生效）。
>    ⚠️ **判据只允许看响应体 `code`**：本项目 **HTTP 恒 200**，被拒时 `data` 是 `null`，
>    拿 `data !== undefined` 判「通过」会把**拒绝误报成通过**（脚本初版就踩了，差点结论反转）。
>    配后存量 token 全作废（学生 + admin-web 重登一次），预期行为。
> ⚠️ 网关 **CORS 白名单含 `localhost`（任意端口）、不含服务器 IP** → 本机 dev 免配跨域，**正式上线必须去控制台加域名**。
> ✅ `Dashboard.vue` 显示瑕疵已修（cloud 模式改为显示云地址；并给 `.kv .mono` 加
>    `min-width:0; overflow-wrap:anywhere` 防长 URL 撑破卡片）。
> ⚠️⚠️ **`jyradio.online` 未备案**（2026-09-29 实测：`https://jyradio.online` **TLS 握手被 RST**，
>    而 `https://129.28.26.180` 正常 200 ⇒ 按 SNI 拦域名；这正是小程序当初 `url not in domain list` 的根因）。
>    ⚠️ **证书 ≠ 备案** —— 别再拿「配了 443 证书」当成备案证据（我踩过一次）。
> ⚠️ **不需要备案的只有两条**：① 服务器 + **纯 IP 访问**（现在就是这么用的）② **云开发静态托管 + 腾讯云默认域名**
>    （能停服务器，但默认域名有「访问提示中间页」、官方明文严禁用于生产）。要用域名 ⇒ **必须备案**。
>    细则与各方案代价见 `cloud/docs/final-cutover.md`。
> ✅ `JWT_SECRET` 反向验证脚本：`cloud/scripts/verify-jwt-secret.js`（纯 Node 手写 HS256，不引依赖）。
> ⚠️ 部署脚本 `deploy-cloud.js` 会同时打印两种终端命令（`</dev/null` 在部分终端里报错）。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 只改 views：`build admin-web` →
  `up -d --force-recreate --no-deps admin-web`；其 Dockerfile 容器内自 build（build context = `./admin-web`，
  `.dockerignore` 只排 node_modules/dist/_backup ⇒ **`.env.local` 会被打进构建、读得到**）。
- ⚠️ **`git pull` 不影响运行中的容器**（容器用构建时的镜像快照）→ 跑一次性脚本（如迁移导出）用
  `docker cp cloud/. radio-backend:/app/cloud` 塞进去（免 rebuild）；⚠️ 必须 `exec -u root`（cp 进去的文件属 root、
  默认 `app` 用户写不了 `out/`）。结尾 `/.` 是「只拷内容」（不写会套成 `/app/cloud/cloud`）。
- **加表**靠启动 `sync({alter:false})`；**加列/索引必须跑 `scripts/db-repair.js`**（幂等、只加不改不删）。
  固定顺序：备份 → build → `run --rm radio-backend node scripts/db-repair.js` → `up -d --force-recreate radio-backend`
  → 幂等回填 UPDATE → `POST /api/admin/submit/queue/sweep`。
- ⚠️ MySQL `ALTER TABLE ADD COLUMN` **不幂等**（重跑 1060 中断后续）。
- ⚠️ **关联一律 `constraints: false`**（默认建物理外键，类型不一致 → `sync()` 3780 → 半建表 + 502）。
- ⚠️ **SQLite 全绿证明不了 MySQL 能建表** → 判据必须 MySQL 实测（skill `sequelize-schema-rollout`）。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。
- 陛下跑 SQL：`docker exec -e MYSQL_PWD="$DB_PASSWORD" -i radio-mysql mysql -uroot "$DB_NAME"`；
  `-p<密码>` 的 warning 在 stderr 不是失败。⚠️ SQL 别用中文别名/标识符（乱码 1064），多行走 `<<'SQL'` heredoc。
  ⚠️ **本机 push 与服务器 pull/build 绝不写进同一代码块**（他整段贴服务器会报只读；deploy key 只读属正常设计）。

## 本机坑
- Bash 可用（管道/heredoc/git）；PowerShell stdout 不回显 → 落盘再 Read。⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。
- **改前端先跑两个源码自检**：`node scripts/check-vue-bindings.js`（未声明 `_ctx.` 引用 —— 构建不报错、运行时只渲染空白）、
  `node scripts/check-wxml-classes.js`。⚠️ 前者「未声明 N 个」含白名单，**判据是下一行 missing 有没有列名字**。
- ⚠️ **深色卡/窄容器尾部提示被 flex-shrink 压扁折行**：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。**判据量 height 不量 width**。
- 不开 Docker 整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + `npm run seed` + `node src/app.js`；
  admin-web 走 vite dev（路由 `/submit/settings`，**不是** `/#/...`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。
  ⚠️ 复用服务**会跨会话掉线**（`curl` 返 502 是本机代理在拦）→ 截图前探活。**`_shot.db` schema 变过要先 `rm` 再 db:init**。
- jest 基线：56 条里 15 条失败全是已删 member 模块（member.test 14 + switch.test 1），别当新回归。
- ⚠️⚠️ **push 本机做不了（已穷尽排查，别再试）**：GCM 非交互取不到凭据 →
  `fatal: unable to get password from user`；**无任何已存凭据**（无 `.git-credentials` / `.netrc`、
  无 `GITHUB_TOKEN` / `GH_TOKEN` / `GIT_ASKPASS`），**`gh` CLI 也未安装**。
  ⇒ commit 我负责，**push 由陛下在自己终端敲**（会弹 GCM 登录窗，登录一次即缓存）。
  判据：**`git status -sb` 里没有 `ahead N`**（别用 `| tail`，会吞进度、已误判过一次）。
- ⚠️⚠️ **部署云函数本机做不了**：沙箱把 `reg.exe` 列入程序黑名单（安全中心 → 命令安全），`cli.bat` 初始化即失败
  （报 `wait IDE port timeout`）⇒ **必须陛下在自己终端跑**。CLI = `D:\dev\wx-devtools\cli.bat`；服务端口**已开**。
- ⚠️ **PowerShell `Add-Type` 被安全策略拦**（禁止运行时编译 .NET）→ 图像裁剪走 Python venv：
  `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（已装 pillow）。
- 截图验证配方见 skill `web-ui-screenshot-verify`。⚠️ **会话跑久 / 用 `location.href` 导航必出空白页**
  （截图恒 3680 字节、`localStorage` 报 Access denied）→ 换 **`--session <独立名>`** 立刻恢复（`doctor --fix` 没用）。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须已 import（漏导入炸成功路径，被当成"操作失败"）。
- 验证脚本（SQLite 内存库）：`verify-song-protocol.js`、`verify-song-submit.js`、`verify-student-account.js`。`verify-song-queue.js` 已作废。
- **三维状态保持数字**：接口同时下发数字 + 名字（`songStatusService.statusView()`）。⚠️ 数字↔常量名只允许在 `songStatusService` 一处定义。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`。
- ⚠️⚠️ **学生初始密码 = `user` + 学号**（`20240101` → `user20240101`），**不是 `usr123456`**（2026-09-18 前的旧规则）。
  定义只在 `studentAccountService.initPasswordFor()`（cost 8；改密后 cost 10）。「学生登不上」先跑
  `node cloud/scripts/whois-student.js <学号>`（需 `JWT_SECRET`）—— 一次给出「库里有没有 / 状态 / 初始密码能不能登」；
  排查手册 `docs/student-account.md` §4.5。
  ⚠️ 管理端学生 DTO 的字段是 **`activated`**（= 已改密），**不是** `isDefaultPwd`（那个只在学生端 `/user/me`）。
  ⚠️ **老服务器 ↔ 云库会分叉**：正式版 direct→老 MySQL、体验版 cloud→云库，在一边改的密码另一边不知道。
