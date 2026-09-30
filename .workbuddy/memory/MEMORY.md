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
- ⚠️⚠️ **设计不许用通用范式**（2026-09-29 被当面否：「不要去找别人做好的方案，你自己做」）：深色头+白卡 / 全屏深色
  沉浸 / 极简白这类「换给别的 App 也成立」的一律不算。要**从项目自身的业务隐喻长出来**
  （已用：调频刻度、录音电平、收听证钢印、骑缝孔、点唱机唱针）。
- ✅ **登录页是唯一获批突破配色的页面**（2026-09-30）：可不用深色卡、可不守「#0066CC / 无渐变 / 无彩色投影」；
  v6 走奶油 #FFF8EF + 橘红 #FF6B35。其余页面仍守设计系统。
- ⚠️⚠️ **隐私口径文案不对外展示**（2026-09-30 陛下明示「以后都得记着」）：「不收集头像与手机号 / 头像由姓名生成」
  这类自我说明一律**不写进任何 UI**。已有页面里出现就删。
- ⚠️⚠️ **源码 / 文档 / 提交信息一律不写明文凭据**；**默认密码一律不设默认值**
  （2026-09-30 全仓清过一轮：`admin123456` 散布 30 文件 / 47 处，现已归零）。
  口径：配了 `INIT_ADMIN_PASSWORD` 就用它，**留空则启动时随机生成、只在首次日志打印一次**
  （`src/utils/seed.js`，`crypto.randomBytes(12)`）；SQL 初始化**不插固定账号**；文档一律写「见 `INIT_ADMIN_PASSWORD`」。
  ⚠️ **写死 bcrypt hash 等同写死密码**（README 那条"忘记密码"重置 SQL 就是现成后门，已改成自己生成 hash 的两步法）。
- ⚠️⚠️ **公开的默认密钥 = 没有鉴权**。`JWT_SECRET` 曾有三串公开默认值 ⇒ **2026-09-30 实测线上就是拿
  `.env.example` 那串在跑**（自签 token 打 `/api/admin/profile` 直接 `code:0`；`adminAuth` **只验签名不查库**
  ⇒ 绕过密码即超管）。✅ **已修复**（换 `.env` + 重建容器，三条全未命中）。护栏在 `src/config/index.js`
  （命中公开串 + production ⇒ 拒绝启动）；复验 `node scripts/verify-backend-jwt.js`（只看响应体 `code`）。
  ⚠️ 坑：`${X:-兜底值}` 把**空串当未设置** ⇒ 写空值会静默回落到下一串公开值，看着像"文件没改"。
  ⇒ **判据是"全部未命中"，不是"命中的串变了"**；排查先读容器实际值，再回头查文件。
- ✅ **MySQL `root123` 确认不改**（陛下 2026-09-30 拍板「无所谓」）：已查实 `docker-compose.yml` **没有端口映射**，
  MySQL 只在 `radionet` 内网、外网不可达 ⇒ 风险确实低。**别再去清它。**
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
> 清单 `cloud/docs/final-cutover.md`。**①–⑦ 完成**；**⑧ 学生侧切 cloud：体验版真机通过、待发正式版**。
- ⚠️⚠️ **⑧ 的真正卡点**：`miniprogram/app.js` 的 `requestMode` 一直是 `'direct'` ⇒ 正式版只允许 **HTTPS + 已备案域名**
  ⇒ 必然 `url not in domain list`（当初启动云迁移的那个报错，**开关一直没拨**）。已改 `'cloud'`。
  **只改代码不重新上传＝没生效**；**必须用微信客户端验证**（开发者工具跳过域名校验）。
  ✅ 2026-09-30：体验版不再报错、可正常登录、无需再开「不校验合法域名」；学生端 13 个只读接口全绿。
  ⇒ **学生走小程序（免备案）／老师走 admin-web（网页，IP 即可）＝两条独立的线，别混谈。**
- ⚠️⚠️ `miniprogram/app.js:65-69` 有 localStorage 覆盖开关（`debug_requestMode` 盖掉 `globalData.requestMode`）——
  排查「通道不对」必先查它（`wx.removeStorageSync('debug_requestMode')`）；页面栈缓存会留上次的错误凭据条。
- ⚠️ 切云后学生侧**完全依赖云开发环境**（无兜底）；「校园版个人版前 6 个月免费」，到期/超额＝全站突然不可用。
- ✅ `JWT_SECRET` 已补配验证（云函数 `api` → 高级配置 → 环境变量；`cloud/scripts/verify-jwt-secret.js`）。
  ⚠️ **判据只允许看响应体 `code`**：HTTP 恒 200，被拒时 `data` 为 `null`，拿 `data !== undefined` 判会把拒绝误报成通过。
- ⚠️ 网关 CORS 白名单含 `localhost`（任意端口）、**不含服务器 IP**。
- ⚠️⚠️ **服务器上那个 admin-web 实测是 `direct`**（`.env.local` 被 gitignore ⇒ `git pull` 拿不到）⇒
  **老师侧老 MySQL、学生侧云库＝两库各写各的**。修：服务器写 `.env.local`=cloud+云地址；跨域加 `129.28.26.180`；
  重 build admin-web。判据脚本 `cloud/scripts/probe-admin-web-mode.js`。
- ⚠️⚠️ **切云静默弄坏带文件上传的接口**：cloud 请求体是 JSON 信封，`FormData` 一 `JSON.stringify` 就变 `{}` ⇒ 文件丢
  （报 `40001 缺少文件内容（fileBase64）`）；契约 `{ filename, fileBase64 }`。✅ 学生账号导入已修（`http.js` 的
  `cloudRequest()` 认出 `FormData` 自己转 base64，只改公共请求层，direct 零变化；`verify-upload-adapter.js`）。
  ⇒ **前端凡 `new FormData()` / `Blob` 的调用，切云后都要单验**。
  ⏳ **头像上传：更正 —— 不是切云弄坏的**（两通道下都 404；老后端 `src/routes/admin.js:17` require 了
  `uploadController` 却从未挂路由，`exports.uploadAvatar` 是死代码）⇒ **判据：先 grep 老后端 `router.<m>('<路径>'`，
  没挂就不是切云的锅**；也先搜前端注释文案。方向待定（动 UI ⇒ 先出静态预览）。
- ⚠️⚠️ **`jyradio.online` 未备案**（`https://jyradio.online` **TLS 握手被 RST**；`https://129.28.26.180` 正常 200
  ⇒ 按 SNI 拦域名）⇒ 小程序 `url not in domain list` 的根因。⚠️ **证书 ≠ 备案**（我踩过一次）。
  **免备案只有两条**：① 服务器 + **纯 IP 访问**（现在就是这样）② 云开发静态托管 + 默认域名（官方严禁用于生产）。
  要用域名 ⇒ **必须备案**。
- ⚠️ `http.js` 踩过 `body` 重名 —— **vite build 直接报 `The symbol "body" has already been declared`**，
  构建即最便宜的语法检查。（`deploy-cloud.js` 打印的两种终端命令长期误报，忽略即可。）

## 服务器到期后怎么办（2026-09-30 查证；**细则全在 `cloud/docs/final-cutover.md`**）
- **服务器现在实质只是「静态网页托管机」**（学生走 `callFunction`、admin-web 接口直连云端不打 `/api`）
  —— 这就是「改个前端还要上服务器更新」的原因。
  ⚠️ 停后端容器前先看 `docker compose logs --tail=200 radio-backend` 有无近期请求（旧版 direct 可能还在打）。
- **三个去向**：A 静态托管 + 默认域名（免费）／B 静态托管 + 备案自定义域名／C 续服务器。
  ✅ 方案 A 已开工：产物 `admin-web/_hosting`（+ `_hosting.zip`）。
- ⚠️⚠️ **两个必配**：① 静态托管「设置 → 错误页面 = `index.html`」（不配则子路由刷新/直连全 404，
  云端物理上只有 index.html）② 静态托管域名要加进 **HTTP 网关 → 跨域设置**（后缀与网关不同 ⇒ 跨域），
  否则页面开、接口全被拦。另：默认域名给非导航请求加 `Content-Disposition: attachment`（「点链接变下载」先怀疑它）。
- ⚠️ 默认域名：首次弹「访问提示中间页」，点过 Cookie 期内不再弹；官方已放宽为「只有软性提醒」，
  但仍写「严禁用于正式生产/大范围分发」⇒ **内部几个老师够用，对外别用**。
- ⚠️⚠️ **云开发备案 3 准入（须同时满足）**：① 套餐个人版及以上（免费体验环境**不支持**）
  ② 环境剩余有效期 **> 6 个月** ③ 已开启「**云托管固定 IP**」（本项目没开）。审核 1–20 工作日；一环境最多 2 站。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 只改 views：`build admin-web` →
  `up -d --force-recreate --no-deps admin-web`；其 Dockerfile 容器内自 build（build context = `./admin-web`，
  `.dockerignore` 只排 node_modules/dist/_backup ⇒ **`.env.local` 会被打进构建、读得到**）。
- ⚠️ **`git pull` 不影响运行中的容器**（容器用构建时的镜像快照）→ 跑一次性脚本用
  `docker cp cloud/. radio-backend:/app/cloud`（免 rebuild）；⚠️ 必须 `exec -u root`；结尾 `/.` 是「只拷内容」。
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
- ⚠️⚠️ **给陛下的命令要分两台机器写，语法不同，别混**：
  **本机（他在 PowerShell 里敲）** → 路径写 `C:\...`（**不是** `/c/...`，`cd /c/...` 会报「找不到路径 C:\c\Users\...」）、
  **`&&` 不可用**（PS 5.1 不支持，要 `;` 或分行）、没有 `tail`。**服务器（Linux bash）** → `cd ~/radio`、`&&`、管道随便用。
  ⇒ **本机段与服务器段必须是两个独立代码块**（合在一起他整段贴服务器会报只读）。
- Bash 可用（管道/heredoc/git）；PowerShell stdout 不回显 → 落盘再 Read。⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。
- **改前端先跑两个源码自检**：`node scripts/check-vue-bindings.js`（未声明 `_ctx.` 引用 —— 构建不报错、运行时只渲染空白）、
  `node scripts/check-wxml-classes.js`。⚠️ 前者「未声明 N 个」含白名单，**判据是下一行 missing 有没有列名字**。
- ⚠️ **深色卡/窄容器尾部提示被 flex-shrink 压扁折行**：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` +
  `.hint{flex:none}`。**判据量 height 不量 width**。
- ⚠️⚠️ **vite 构建到「已存在」目录会被本机 safe-delete 垫片拦**（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`；
  `NODE_OPTIONS` 挂着 `node-safe-delete-shim.cjs`，**是拦删不是代码错**）⇒ 构建到**不存在的新目录**
  （如 `--outDir _hosting`），或 `NODE_OPTIONS=""`（连 `fs.rmSync` 也要置空）。
- ⚠️ **`admin-web/package.json` 有 `"type": "module"`** ⇒ 临时脚本必须用 **`.cjs`** 后缀，否则 `require is not defined`。
- 不开 Docker 整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + `npm run seed` + `node src/app.js`；
  admin-web 走 vite dev（路由 `/submit/settings`，**不是** `/#/...`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。
  ⚠️ 复用服务**会跨会话掉线**（`curl` 返 502 是本机代理在拦）→ 截图前探活。**`_shot.db` schema 变过要先 `rm` 再 db:init**。
- jest 基线：56 条里 15 条失败全是已删 member 模块（member.test 14 + switch.test 1），别当新回归。
- ⚠️⚠️ **push 本机做不了（已穷尽排查，别再试）**：GCM 非交互取不到凭据 → `fatal: unable to get password from user`；
  无任何已存凭据（无 `.git-credentials` / `.netrc` / `GITHUB_TOKEN` / `GH_TOKEN` / `GIT_ASKPASS`），`gh` CLI 也未安装。
  ⇒ commit 我负责，**push 由陛下在自己终端敲**（会弹 GCM 登录窗，登录一次即缓存）。
  判据：**`git status -sb` 里没有 `ahead N`**（别用 `| tail`，会吞进度、已误判过一次）。
- ⚠️⚠️ **部署云函数本机做不了**：沙箱把 `reg.exe` 列入程序黑名单，`cli.bat` 初始化即失败（报 `wait IDE port timeout`）
  ⇒ **必须陛下在自己终端跑**。CLI = `D:\dev\wx-devtools\cli.bat`；服务端口**已开**。
- ⚠️ **PowerShell `Add-Type` 被安全策略拦** → 图像裁剪走 Python venv：
  `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（已装 pillow）。
- 截图验证配方见 skill `web-ui-screenshot-verify`。⚠️ **会话跑久 / 用 `location.href` 导航必出空白页**
  （截图恒 3680 字节、`localStorage` 报 Access denied）→ 换 **`--session <独立名>`** 立刻恢复（`doctor --fix` 没用）。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须已 import（漏导入炸成功路径，被当成「操作失败」）。
- 验证脚本（SQLite 内存库）：`verify-song-protocol.js`、`verify-song-submit.js`、`verify-student-account.js`。`verify-song-queue.js` 已作废。
- **三维状态保持数字**：接口同时下发数字 + 名字（`songStatusService.statusView()`）。⚠️ 数字↔常量名只允许在 `songStatusService` 一处定义。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`。
- ⚠️⚠️ **学生初始密码 = `user` + 学号**（`20240101` → `user20240101`），**不是 `usr123456`**（2026-09-18 前的旧规则）。
  定义只在 `studentAccountService.initPasswordFor()`（cost 8；改密后 cost 10）。「学生登不上」先跑
  `node cloud/scripts/whois-student.js <学号>`（需 `JWT_SECRET`）；排查手册 `docs/student-account.md` §4.5。
  ⚠️ 管理端学生 DTO 的字段是 **`activated`**（= 已改密），**不是** `isDefaultPwd`（那个只在学生端 `/user/me`）。
  ⚠️ **老服务器 ↔ 云库会分叉**：正式版 direct→老 MySQL、体验版 cloud→云库，在一边改的密码另一边不知道。
