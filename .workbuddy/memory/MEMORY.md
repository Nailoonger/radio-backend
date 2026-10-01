# 菁悠广播站 · 项目长期备忘

> 只留铁律 + 固定顺序 + 反复踩的坑。细则见 `docs/`、`cloud/docs/final-cutover.md`、
> `.workbuddy/memory/PROJECT-NOTES.md`、各 skill。**本文件必须精简，超限会在注入时被截断。**

## 铁律
- **只做加法**：原 `src/` + `admin-web/` + Docker 一行不删，保留 `requestMode: 'direct'|'cloud'`。
  **绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉**先出静态预览并标版本号（v1/v2…），点头前不写业务代码**；版本只增不删。被否 → 先问清形态，别自行捡回。
- ⚠️⚠️ **设计不许用通用范式**（被当面否过「不要去找别人做好的方案，你自己做」）：换给别的 App 也成立的
  模板一律不算 → 要**从业务隐喻长出来**（已用：调频刻度、录音电平、收听证钢印、骑缝孔、点唱机唱针）。
- ✅ **登录页是唯一获批突破配色的页面**（可不用深色卡、不守 #0066CC/无渐变/无彩色投影）。其余守设计系统。
- ⚠️⚠️ **隐私口径文案不对外**（"不收集头像/头像由姓名生成"这类自我说明不写进 UI）。
- ⚠️⚠️ **源码/文档/提交信息不写明文凭据**；**默认密码不设默认值**（留空则随机生成、只首次日志打印一次）。
  ⚠️ **写死 bcrypt hash 等同写死密码**。
- ✅ `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）。⚠️ `${X:-兜底}` 把**空串当未设置** ⇒
  写空会静默回落；**判据是"全部未命中"，不是"命中的串变了"**。
- ✅ **MySQL `root123` 确认不改**（陛下拍板；compose 无 ports 映射，外网不可达）。**别再去清它。**

## ⚠️⚠️ 动 UI / 编内容之前
> 起因：做官网介绍页时没读文档就自起配色、自编内容，被陛下当面点名（同类错已犯两次）。
- **必须先读 `PROJECT-NOTES.md` 的「动 UI / 编内容之前，先读这三处源」一节** ——
  设计 token 源、真实内容源、结构事实源三处都在那儿。
- 记死两条底线：**别自起私有配色**（守 `theme.css` 的三硬规则）；**别再编任何业务事实**
  （站里没有 FM 频率——"87.6MHz"是编的，被点过）。

## 启动动画素材（v4 拆好的零件，等点头）
- 站徽底稿 1410×1410，**圆心 = 图心 (704.5, 704.5)**；深蓝 `#093592` / 浅蓝 `#2497D5`。
  环形文字：中文 5 字顺时针走**顶**、英文 18 字母逆时针走**底**，**两行都是西起东收**。
- 零件在 `preview/launch-v4/assets/`（80 张 PNG + `parts.json`/`arcs.json`/`sprite.png`+坐标表）。
  ⚠️ 切图统一 **`alpha > 0`**（用 `alpha>100` 会丢抗锯齿边 → 外环少 6.6%）；
  ⚠️ 校验零件要按清单 `(x,y)` **平移回绝对坐标**，否则「缺失==多出」是假错。
  细则见 skill `bitmap-logo-split-animate`。
- ✅ 线上 `miniprogram/components/launch-mask/` **仍是 v1，一个字没动**。
  等陛下在 `preview/launch-v4/index.html` 上点头（时长档 2.6s/1.7s、环 A 逐段点亮 / B 整环扫频）。

## 管理端小程序（分包 `pages-admin/`，2026-10-01 落地）
> 细则见 `PROJECT-NOTES.md`「管理端小程序」一节。
- 一期＝登录 / 待办台 / 投稿&点歌审核 / 审核处理台 / 留言审核；**排期、批量、学生账号、系统设置仍在电脑端**。
- ⚠️⚠️ **管理端 token 分键**（`admin_token` + `globalData.adminToken`），请求**只能用 `adminRequest()`**；
  与学生端共用一个 `token` key 会互相顶掉登录态。
- ⚠️ **驳回理由服务端必填** ⇒ 列表页「驳回」跳处理台；留言「屏蔽」用 editable modal 收原因。
- 处理台 = L1 白卡大投影（`--sh-lift` 纯黑透明）；⚠️ 页面底转灰后 `--soft` 提示会糊底 → 提到 `--muted`。
  ❌ 处理台四段（投稿人/内容/驳回/记录）**不合并** —— 陛下看过 v10/v11 后说"算了，先维持现状"，
  **别自己合**（设计稿留在 `preview/admin-mp-v10` 与 `-v11`）。
- 待办台 = L1 + **C 案「主浮次平」**（待办卡浮 / 入口卡贴平）；**顶栏右侧一律留空**（微信胶囊地盘）。
  ✅ 2026-10-01 定版：标题「**导播台**」+ 「指导老师」在**标题下面**（两行文字块，v12-C）；
  待办卡右上角空着。⚠️ 顶栏**不能写死 `height`**（112rpx vs 单行 88rpx）→ 用 `min-height`；徽章 64rpx。
  ⚠️ 这屏**没有深色卡**了，别在别的屏扩散。
- ⚠️⚠️ **站徽 PNG 是透明底**（环形文字镂空，四角 alpha=0）⇒ 当图标用**必须自己给 `background`**，
  否则镂空处透出页面底色（灰底上环字像"缺字"）。顶栏 `.badge` 已加白底。
  ⚠️ 白底 ≠ 卡片：徽章卡片形态（v13 方块 / v14 正圆）**另行讨论，还没定**。
- 改管理端 wxss 必跑 `node preview/_check-admin-mp.cjs`（`未定义 CSS 变量: 0`）。
- ⚠️⚠️ **`<text>` 保留换行** ⇒ 内容拆行写会多一个空行把胶囊撑高（真机报过「红绿胶囊错位」）。
  文案一律在 js `decorate()` 里拼好（`tagClass`/`tagText`），**wxml 一行写完**；
  判据 `check-wxml-classes.js` 的 `<text> 跨行: 无 OK`。细则见 skill `wxml-render-traps`。
- ⚠️⚠️ **投影档位名 ≠ 可见度**（2026-10-01 实测）：`--sh-card`（4% 黑）叠在 `#F5F5F7` 上**归零**
  （卡左侧灰底 min=245，与"完全无影"逐像素一致）⇒ 表达不了"浮起来"；要浮必须 `--sh-lift`(237)
  或中间档 `0 4px 12px -4px rgba(0,0,0,.10)`(241)。**别照档位名写交付说明 —— 采样像素**（差<6 灰阶＝没差别）。
- ⚠️ **顶栏/导航区要变白底 → 先想微信胶囊**：胶囊本身是白色圆角条，会和白卡糊死（只剩 1px 描边）。

## 云开发迁移（`cloud/`）— 阶段 0–9 完成，回归 3115 项 / 0 失败
> 细则（三约束三陷阱 / httpBridge / 回归速查）见 `PROJECT-NOTES.md` 与 skill `express-to-cloudfunction-migration`。
- 源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。
  ⚠️ **Windows CLI 传子目录必坏** → `sync.js` 打成**单文件 index.js**；⇒ `handlers/index.js` 必须是**静态注册表**。
- 部署：`node cloud/scripts/deploy-cloud.js` → 手动 cli.bat → **等 1~2 分钟**。
- 口径：业务查询一律**数字 `id`**；4 张表用业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段**驼峰**；
  ⚠️ `insertOne` 后改这行要用**返回的 `_id`**。
- ⚠️⚠️ **切云弄坏上传类接口**：信封是 JSON，`FormData` 一 `JSON.stringify` 变 `{}`（报 `40001`）；契约 `{ filename, fileBase64 }`。
  ✅ 学生导入已修。**前端凡 `FormData`/`Blob` 切云后都要单验**。
  ⏳ 头像上传**不是切云的锅**（老后端从未挂路由）→ 判据：先 grep 老后端 `router.<m>('<路径>'`。

## 真机收尾 & 域名（陛下动手）
> 清单 `cloud/docs/final-cutover.md`（①–⑦ 完成；⑧ 学生侧切 cloud：体验版通过、待发正式版）。
- **线上网页（陛下确认就用这个）** = `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`
  （与 `jy-radio-d1gdwmptl816ee6a9-1491709115.tcloudbaseapp.com` **内容一致、都在跨域白名单**；
  ⚠️ 少写 `-1491709115` 的那串返回 **418**）。API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`（跨域）。
- ✅ **静态托管两个必配都已完成**：① SPA fallback ② 域名加进 **HTTP 网关 → 跨域设置**。
  ⚠️⚠️ **fallback 的正确入口（新版控制台，官方配方那套已过时）**：
  静态网站托管 →「基础配置」→「**路由配置**」→ 编辑 → 加规则「**错误码 404 → 替换路径 `/index.html`**」。
  ⚠️ 官方 `recipes/add-hosting-*` 写的「设置标签页 → 错误页面」**在新版控制台不存在**（陛下找过，别再照抄）。
  ⚠️ 它是**内部重写（200、地址栏不变）不是 302**；副作用：不存在的路径也返回 index.html + 200。
  默认域名有中间页且官方严禁生产。
- ⚠️⚠️ **首次打开会弹「风险提醒」中间页（404 + `<title>风险提醒</title>` ~18KB）—— 不是部署坏了**：
  点「确定访问」即进，之后同域 8h 不再弹（下发 `cloudbase_confirm_domain_access`）。
  正文那句「当前访问量已达上限」是**模板固定文案**，不代表真被限流。
  ⇒ **探测它必须带浏览器同款请求头（含同域 `Referer`）、只能用 Node `https`**（本机代理会剥掉自定义头，
  用 `curl` 会得出反向结论 —— 我在 attachment 上误报过一次）。细则见 `cloud/docs/final-cutover.md` §②-b-1。
- ⚠️⚠️ **⑧ 的卡点是开关**：`requestMode` 一直是 `'direct'` ⇒ 正式版只允 HTTPS+已备案域名 ⇒ `url not in domain list`。已改 `'cloud'`。
  **只改代码不重新上传＝没生效**；**必须用微信客户端验**。
  ⇒ **学生走小程序（免备案）／老师走 admin-web ＝两条独立的线，别混谈。**
- ⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖 —— 排查"通道不对"先查它。
- ⚠️ 切云后学生侧**无兜底**，依赖云环境；"前 6 个月免费"，到期/超额＝全站突然不可用。
- ✅ `JWT_SECRET` 已补配（云函数 `api` → 高级配置 → 环境变量）。⚠️ **判据只看响应体 `code`**（HTTP 恒 200，被拒时 `data` 为 `null`）。
- ⚠️⚠️ **服务器 admin-web 实测是 `direct`**（`.env.local` 被 gitignore ⇒ pull 拿不到）⇒ **老师侧老 MySQL、学生侧云库各写各的**。
  修：服务器写 `.env.local`=cloud；跨域加 `129.28.26.180`；重 build。判据 `cloud/scripts/probe-admin-web-mode.js`。
- ⚠️⚠️ **`jyradio.online` 未备案**（TLS 被 RST，纯 IP 正常 ⇒ 按 SNI 拦）。⚠️ **证书 ≠ 备案**。要用域名 ⇒ 必须备案。
- ⚠️ 云开发备案 3 准入（同时满足）：套餐≥个人版 ② 环境剩余 > 6 个月 ③ 已开**云托管固定 IP**（本项目没开）。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。
  ⚠️ **`git pull` 不影响运行中的容器** → 一次性脚本用 `docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。
- 加列/加索引的固定顺序与坑（`ADD COLUMN` 不幂等、关联必须 `constraints: false`、SQLite 证明不了 MySQL）
  见 skill `sequelize-schema-rollout`。顺序：备份 → build → `scripts/db-repair.js` → up → 回填 → `queue/sweep`。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。

## 本机坑
- ⚠️⚠️ **给陛下的命令分两台机器写**：本机 PowerShell → 路径 `C:\...`（**不是** `/c/...`）、**无 `&&`**（要 `;`）、无 `tail`；
  服务器 bash → `cd ~/radio`、`&&`、管道随便用。**两段必须是两个独立代码块**（合在一起他整段贴服务器会报只读）。
  ⚠️ **不要给需要交互输入的命令**（`read -s` 整段粘贴必翻车）；**要给判据行**（他按判据回报）。
- ⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。PowerShell stdout 不回显 → 落盘再 Read。
- **改前端先跑**：`scripts/check-vue-bindings.js`、`scripts/check-wxml-classes.js`。
  ⚠️ 前者"未声明 N 个"含白名单，**判据是下一行 missing 有没有列名字**。
- ⚠️ 深色卡尾部提示被 flex-shrink 压扁：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。判据量 height。
- ⚠️⚠️ **vite 构建到"已存在"目录会被 safe-delete 垫片拦**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，**是拦删不是代码错**）
  ⇒ 构建到**不存在的新目录**（`--outDir _hosting`）；`_*` 已被 gitignore。
- ⚠️ `admin-web/package.json` 有 `"type": "module"` ⇒ 临时脚本用 **`.cjs`** 后缀。
- 不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；admin-web 走 vite dev（`/submit/settings`，**不是** `/#/...`）。
  ⚠️ 复用服务**会跨会话掉线**（curl 返 502 是本机代理在拦）→ 截图前探活。**`_shot.db` schema 变过要先 `rm`**。
- jest 基线：56 条里 15 条失败全是已删 member 模块（member.test 14 + switch.test 1），别当新回归。
- ⚠️⚠️ **push 本机做不了（别再试）**：GCM 非交互取不到凭据，无已存凭据，`gh` 未装 ⇒ commit 我负责，**push 陛下自己敲**。
  判据：`git status -sb` 里**没有 `ahead N`**（别用 `| tail`，会吞进度）。
- ⚠️⚠️ **部署云函数本机做不了**（沙箱拦 `reg.exe`）⇒ **陛下自己跑**。CLI = `D:\dev\wx-devtools\cli.bat`；服务端口已开。
- ⚠️ PowerShell `Add-Type` 被拦 → 图像处理走 Python venv `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`。
- 截图见 skill `web-ui-screenshot-verify`。⚠️ **会话跑久 / `location.href` 导航必出空白页**（截图恒 3680 字节）→ 换 **`--session <独立名>`**。
  ⚠️ **agent-browser 可能 spawn EBUSY（起不来）→ 改用 Chrome 无头**（可用！旧"不可用"结论已作废）；
  ⚠️⚠️ **`--virtual-time-budget` 不推进 CSS 动画** ⇒ 验动画中间帧要让**页面自己定格**（`#t=毫秒` + `getAnimations()` pause）。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 图标必须已 import（漏导入炸成功路径）。
- **三维状态保持数字**：接口同时下发数字 + 名字；数字↔常量名只许在 `songStatusService` 定义。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES`；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`。
- ⚠️⚠️ **学生初始密码 = `user` + 学号**（`20240101` → `user20240101`），**不是 `usr123456`**。
  唯一出口 `studentAccountService.initPasswordFor()`（初始 cost 8，改密后 10）。排查跑 `node cloud/scripts/whois-student.js <学号>`。
  ⚠️ 管理端学生 DTO 字段是 **`activated`**（= 已改密），不是 `isDefaultPwd`（那个只在学生端 `/user/me`）。
  ⚠️ **老服务器 ↔ 云库会分叉**：一边改的密码另一边不知道。
