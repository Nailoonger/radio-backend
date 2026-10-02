# 菁悠广播站 · 项目长期备忘

> 只留铁律 + 固定顺序 + 反复踩的坑。细则见 `docs/`、`cloud/docs/final-cutover.md`、
> `.workbuddy/memory/PROJECT-NOTES.md`、各 skill。**本文件必须精简，超限会被截断。**

## 铁律
- **只做加法**：`src/` + `admin-web/` + Docker 一行不删，保留 `requestMode: 'direct'|'cloud'`。
  **绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉**先出静态预览并标版本号（v1/v2…），点头前不写业务代码**；版本只增不删。被否 → 先问清形态，别自行捡回。
- ⚠️⚠️ **设计不许用通用范式**（"换给别的 App 也成立"＝没做）→ 要**从业务隐喻长出来**
  （已用：调频刻度、录音电平、收听证钢印、骑缝孔、点唱机唱针）。
- ✅ **登录页是唯一获批突破配色的页面**；其余守设计系统。
- ⚠️⚠️ **学生登录页不再有微信登录**（2026-10-02 拍板）：按钮彻底删掉，**以后不要再做微信登录入口/接口**。
- ✅ **站徽「菁悠」双色 = 浅 `#2497D5` / 深 `#093592`**（源：`站标/菁悠水印.png`、`preview/assets/station-badge.png`）。
  电平表/进度/声波这类"仪器感"元件用这组渐变，别用 `#0066CC` 或警示红（`--live` 只留给 ON AIR）。
- ⚠️⚠️ **不锈钢一律不要拉丝**（被点名两次）＝**不做拉丝纹理**。抛光＝冷中性灰底 + 宽而柔斜向扫光，平滑无纹理；
  反光带窄而硬＝褶皱（小尺寸过渡要宽 22→48→74、亮度 ≤ .30；站徽投影 ≤ .30，暗晕也是"皱"的来源）。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**；`preview/*` 只是二手还原（连标「原样」的也有错）。
  提案稿未落业务代码一律不算现有。判据：这个版本落过业务代码吗。
- ⚠️⚠️ **隐私口径文案不对外**（"不收集头像/头像由姓名生成"这类不写进 UI）。
- ⚠️⚠️ **源码/文档/提交信息不写明文凭据**；**默认密码不设默认值**（留空则随机生成 + 只首次日志打印一次）。
  ⚠️ **写死 bcrypt hash 等同写死密码**。
- ✅ `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）。⚠️ `${X:-兜底}` 把**空串当未设置** ⇒
  写空会静默回落；**判据是"全部未命中"**。
- ✅ **MySQL `root123` 确认不改**（陛下拍板）。**别再去清它。**

## ⚠️⚠️ 动 UI / 编内容之前
- **必须先读 `PROJECT-NOTES.md` 的「动 UI / 编内容之前，先读这三处源」**（设计 token 源 / 真实内容源 / 结构事实源）。
- 两条底线：**别自起私有配色**（守 `theme.css` 三硬规则）；**别编业务事实**（站里没有 FM 频率——"87.6MHz"是编的，被点过）。

## 管理端小程序（分包 `pages-admin/`）
- 一期＝登录/待办台/投稿&点歌审核/处理台/留言审核；排期、批量、学生账号、系统设置仍在电脑端。细则见 `PROJECT-NOTES.md`。
- ⚠️⚠️ **token 分键**（`admin_token` + `globalData.adminToken`），请求**只能用 `adminRequest()`**；共用 `token` key 会互相顶掉登录态。
- ⚠️ **驳回理由服务端必填** ⇒ 列表「驳回」跳处理台；留言「屏蔽」用 editable modal。
- ❌ 处理台四段（投稿人/内容/驳回/记录）**不合并**（陛下看过 v10/v11 说"先维持现状"）。
  待办台 = L1 + C 案「主浮次平」；**顶栏右侧一律留空**（微信胶囊）；标题「导播台」+「指导老师」在下面；
  ⚠️ 顶栏用 `min-height` **不能写死 `height`**。
- ⚠️⚠️ **站徽 PNG 是透明底** ⇒ 当图标用**必须自己给 `background`**，否则镂空处透出底色。徽章卡片形态（v13 方块/v14 正圆）**还没定**。
- 改管理端 wxss 必跑 `node preview/_check-admin-mp.cjs`（判据 `未定义 CSS 变量: 0`）。
- ⚠️⚠️ **`<text>` 保留换行** ⇒ 文案一律在 js `decorate()` 里拼好（`tagClass`/`tagText`）、**wxml 一行写完**。细则见 skill `wxml-render-traps`。
- ⚠️⚠️ **投影档位名 ≠ 可见度**：`--sh-card` 叠在 `#F5F5F7` 上**归零**；要浮必须 `--sh-lift` 或 `0 4px 12px -4px rgba(0,0,0,.10)`。
  **交付说明别照档位名写，采样像素**（差 <6 灰阶＝没差别）。

## 云开发（`cloud/`）阶段 0–9 完成，回归 3115 项 / 0 失败
- 源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。
  ⚠️ **Windows CLI 传子目录必坏** → `sync.js` 打成**单文件 index.js**；⇒ `handlers/index.js` 必须**静态注册表**。
- 部署：`node cloud/scripts/deploy-cloud.js` → 手动 cli.bat → **等 1~2 分钟**。
- 口径：业务查询一律**数字 `id`**；4 张表用业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段**驼峰**；
  ⚠️ `insertOne` 后改这行要用**返回的 `_id`**。
- ⚠️⚠️ **切云弄坏上传类接口**：信封是 JSON ⇒ `FormData` 一 stringify 变 `{}`（40001）；契约 `{ filename, fileBase64 }`。
  **前端凡 `FormData`/`Blob` 切云后都要单验**。
- ⚠️⚠️ **学生初始密码 = `user` + 学号**（唯一出口 `studentAccountService.initPasswordFor()`；初始 cost 8、改密后 10）。
  ⚠️ 管理端学生 DTO 字段是 **`activated`**（不是 `isDefaultPwd`）。

## 发布 & 真机收尾
- ✅✅ **发布只看一条：`git push` master 即自动发布**（`.github/workflows/cloud-release.yml` + `scripts/release/*`）：
  verify → publish（**只发变更的那一端**）。⚠️⚠️ **别再手动上传静态托管 / 别再手动部署云函数**。
  分类器 `scripts/release/policy.js`；预检 `node scripts/release/verify.js --scope mini`（full 在本机撞垫片）。
- **线上网页** = `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`
  （少写 `-1491709115` 的那串返 **418**）。API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。
- 管理后台线上 = 静态托管（**不是**服务器 Docker）。**手搓**才用 `_hosting`：本机 `.env.local` 被 gitignore
  ⇒ 裸 `vite build` 出的是 **direct 包（无 `jy-radio-`）接口必废**；判据 `grep -oh jy-radio- _hosting/assets/*.js` 必须命中。
- ✅ 静态托管两个必配已完成：① SPA fallback ＝ 静态网站托管 →「基础配置」→「**路由配置**」→「错误码 404 → 替换 `/index.html`」
  （⚠️ 官方 recipes 那套已过时；是**内部重写 200** 不是 302）。② 域名进 **HTTP 网关 → 跨域设置**。
- ⚠️⚠️ **首次打开弹「风险提醒」中间页**（404 + `<title>风险提醒</title>`）**不是部署坏了**：点「确定访问」即进（8h 不再弹）。
  ⇒ 探测必须带**浏览器同款请求头（含同域 Referer）、只用 Node `https`**（用 curl 会得出反向结论）。细则 `cloud/docs/final-cutover.md` §②-b-1。
- ⚠️⚠️ **⑧ 的卡点是开关**：`requestMode` 已改 `'cloud'`；**只改代码不重新上传＝没生效**，**必须用微信客户端验**。
  ⇒ **学生走小程序（免备案）/ 老师走 admin-web ＝两条独立的线，别混谈。**
- ⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖 —— 排查"通道不对"先查它。切云后学生侧**无兜底**。
- ⚠️⚠️ **`jyradio.online` 未备案**（TLS 被 RST；**证书 ≠ 备案**）。云开发备案 3 准入：套餐≥个人版 + 剩余 > 6 个月 + 已开云托管固定 IP。
- ✅ **服务器上那份 admin-web 已下线**（`5805b6d`）：compose 去掉 admin-web 服务、nginx `location /` 301 跳静态托管地址。
  ⇒ **管理后台只有静态托管一份**；"改完看不到"**先问地址栏**。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。
  ⚠️ **`git pull` 不影响运行中的容器** → 一次性脚本用 `docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。
- 加列/加索引顺序与坑见 skill `sequelize-schema-rollout`：备份 → build → `scripts/db-repair.js` → up → 回填 → `queue/sweep`。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。

## 本机坑
- ⚠️⚠️ **给陛下的命令分两台机器写**：本机 PowerShell → `C:\` 路径、**无 `&&`**、无 `tail`；
  服务器 bash → `cd ~/radio`、`&&`、管道随便用。**两段必须是两个独立代码块**。
  ⚠️ **不给需要交互输入的命令**；**必须给判据行**。
- ⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。PowerShell stdout 不回显 → 落盘再 Read。
- **改前端先跑**：`scripts/check-vue-bindings.js`、`scripts/check-wxml-classes.js`（前者判据＝ missing 有没有列名字）。
- ⚠️ 深色卡尾部提示被 flex-shrink 压扁 → 改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`，判据量 height。
- ⚠️⚠️ **vite 构建到"已存在"目录会被 safe-delete 垫片拦**（是拦删不是代码错）⇒ 构建到**不存在的新目录**（`--outDir _hosting`）。
- ⚠️ `admin-web/package.json` 有 `"type": "module"` ⇒ 临时脚本用 **`.cjs`** 后缀。
- 不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；admin-web 走 vite dev（`/submit/settings`）。
  ⚠️ 复用服务**会跨会话掉线** → 截图前探活；**`_shot.db` schema 变过要先 `rm`**。
- jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
- ⚠️⚠️ **push 本机做不了（别再试）**：GCM 取不到凭据、`gh` 未装 ⇒ commit 我负责，**push 陛下自己敲**。判据 `git status -sb` 里**没有 `ahead N`**。
- ⚠️⚠️ **部署云函数本机做不了**（沙箱拦 `reg.exe`）⇒ **陛下自己跑**。CLI `D:\dev\wx-devtools\cli.bat`。
- ⚠️ PowerShell `Add-Type` 被拦 → 图像处理走 Python venv `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`。
- 截图见 skill `web-ui-screenshot-verify`：⚠️ 会话跑久 / `location.href` 导航必出空白页（截图恒 3680 字节）→ 换 `--session <独立名>`。
  ⚠️ agent-browser 可能 EBUSY → 改用 Chrome 无头。⚠️⚠️ `--virtual-time-budget` 不推进 CSS 动画 ⇒ 验中间帧要让页面自己定格。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 图标必须已 import。
- **三维状态保持数字**；数字↔常量名只许在 `songStatusService` 定义。
- **新开关不进 `seed.js`**（switch.test 断言恰好 4 条）→ 走 `switchService.KNOWN_SWITCHES`；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**（`create_time ASC, id ASC`）。
- ⚠️ **老服务器 ↔ 云库会分叉**：一边改的密码另一边不知道。

## 启动动画素材（v4 零件，等点头）
- 站徽底稿 1410×1410，**圆心 = 图心 (704.5, 704.5)**；深蓝 `#093592` / 浅蓝 `#2497D5`。
  环字：中文 5 字顺时针走**顶**、英文 18 字母逆时针走**底**，两行都西起东收。
- 零件在 `preview/launch-v4/assets/`（80 PNG + `parts.json`/`arcs.json`/`sprite.png`+坐标表）。
  ⚠️ 切图统一 **`alpha > 0`**（`alpha>100` 会丢抗锯齿边 → 外环少 6.6%）；⚠️ 校验要按清单 `(x,y)` **平移回绝对坐标**。
  细则见 skill `bitmap-logo-split-animate`。
- ✅ 线上 `miniprogram/components/launch-mask/` **仍是 v1，一个字没动**。等陛下在 `preview/launch-v4/index.html` 点头。
