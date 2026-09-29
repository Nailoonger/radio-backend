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
> 清单 `cloud/docs/final-cutover.md`。**①–⑦ 全部完成**（2026-09-29 陛下浏览器登录成功，闭环）。
> ⑦ 实测：8 个管理端接口全绿（含真返回 xlsx）；真实 Chromium 跨域直连成功、`/dashboard` 渲染出云端数据；`dist/` 无 direct 残留。
> ⚠️ **云函数未配 `JWT_SECRET`**（实测用代码兜底值自签的 token 能过校验）→ **要配就现在配**，配上会让已签发 token 全失效；
>    不配则兜底值写在仓库里，能伪造超管 token。
> ⚠️ 网关 **CORS 白名单含 `localhost`（任意端口）、不含服务器 IP** → 本机 dev 免配跨域，**正式上线必须去控制台加域名**。
> ✅ `Dashboard.vue` 显示瑕疵已修（cloud 模式改为显示云地址；并给 `.kv .mono` 加
>    `min-width:0; overflow-wrap:anywhere` 防长 URL 撑破卡片）。
> ⚠️⚠️ **`jyradio.online` 未备案**（2026-09-29 实测：`https://jyradio.online` **TLS 握手被 RST**，
>    而 `https://129.28.26.180` 正常 200 ⇒ 按 SNI 拦域名；这正是小程序当初 `url not in domain list` 的根因）。
>    ⚠️ **证书 ≠ 备案** —— 别再拿「配了 443 证书」当成备案证据（我踩过一次）。
> ⚠️ **不需要备案的只有两条**：① 服务器 + **纯 IP 访问**（现在就是这么用的）② **云开发静态托管 + 腾讯云默认域名**
>    （能停服务器，但默认域名有「访问提示中间页」、官方明文严禁用于生产）。要用域名 ⇒ **必须备案**。
>    细则与各方案代价见 `cloud/docs/final-cutover.md`。
> ⚠️ `JWT_SECRET` 已批准补配：**判据必须反向验证** —— 兜底密钥自签的 token 调用要变成 `40101`；
>    只验「能登录」不够（配错了照样能用兜底值登进去）。
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
- ⚠️ **push 本机推不了**（GCM 非交互取不到凭据）⇒ commit 我负责，**push 由陛下在自己 PowerShell 敲**。
  先 `curl` 预热探活，再 `git -c credential.guiPrompt=false -c credential.interactive=never push --progress origin master`。
  ⚠️⚠️ **唯一可信判据是 `git status -sb` 无 `ahead N`**（`| tail` 会吞进度，已误判过一次）。
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
