# 菁悠广播站 · 项目长期备忘

> 只留铁律 + 固定顺序 + 反复踩的坑。**细则见 `PROJECT-NOTES.md`（本文件超限会被截断，故只留判据级铁律）**、
> `docs/`、`cloud/docs/final-cutover.md`、各 skill。

## 铁律
- **只做加法**：`src/` + `admin-web/` + Docker 一行不删，保留 `requestMode: 'direct'|'cloud'`。**绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉**先出静态预览并标版本号（v1/v2…），点头前不写业务代码**；版本只增不删。被否 → 先问清形态，别自行捡回。
  ⚠️⚠️ **复制目录做新版本后第一件事：改"页面上给人看的版本号"**（title + 页面内文案），不只是目录名 ——
  否则陛下看到旧版本号会直接判定"没更新"（v5 被点过）。判据 `grep -o "v<N-1>" 新目录/*.html` = 0。
- ⚠️⚠️ **设计不许用通用范式**（"换给别的 App 也成立"＝没做）→ 要**从业务隐喻长出来**
  （已用：调频刻度、录音电平、收听证钢印、骑缝孔、点唱机唱针、校园校舍）。
- ⚠️⚠️ **不要深色——任何形式**（被点名三次：v2 深色胶囊 → v5 深色卡片 → v5.1 深色卡）。
  ❌ 深色药丸（tabBar 选中态/分段/日期/主按钮）❌ 深色卡 ❌ 深色仪器面板 ❌ 深色横幅 ❌ 深色浮层。**一个都不留。**
  ✅ 一律白卡 + 深色字 + 羊皮纸底；选中态 `--accent-tint` 底 / `--accent` 字；主按钮 `--accent`；浮层白底 + 投影。
  ⚠️ 改浅色最易漏的连带项：① 站徽白底圆换 `--parchment`；② 深色卡上的白字与 `rgba(255,255,255,x)` 换 `--ink/--muted/--soft`；
  ③ SVG 里**硬编码**的刻度线/基线/刻度数字色；④ **文案本身**（右栏还写"深色卡：…"会自相矛盾）。
  判据：`grep -c "var(--tile)" 页面` = 0。
- ⚠️ **手机里不要装饰性描边框**（v5.2 被截图点名「蓝色框框哪里来的给我删掉」）。
  保留判定 = **这个框有没有状态含义**（已选态/输入框 focus/`.slot.mine` 留；纯"标一下这层"的删）。
  ⇒ 演示/标注类视觉一律加在**手机外**（左栏、右栏说明）。
- ✅ **「四层纵向单列」只用于「我的」一屏**（2026-10-09 陛下当面纠正：「我刚刚只说了个人页面用那个排版」）。
  其余页各按自己的信息排，**不套统一模板**，也不强制"每页都有三个数"。
- ✅ **全套圆角胶囊**：单行元素（按钮/标签/分段/日期/多格/列表行/输入框）`9999px`；**内容卡片 `28px`**。
  ⚠️ 卡片也上 9999px 会拉成橄榄球、站徽标题贴弧线（实测截图）。列表容器可拆成「一行一个胶囊」。
- ⚠️⚠️ **线上站点目录 = `preview/partner-hub-gounucai-v5/`**（分享链接绑的是这个目录）。
  新版本成果要 **先 `cp` 回 v5 目录再发布**，否则 sites 按目录找 app ⇒ 新建 app、给新链接（陛下被绕烦过一次）。
- ⚠️⚠️ **学生登录页不再有微信登录**（2026-10-02 拍板），**以后不要再做微信登录入口/接口**。
- ✅ **站徽「菁悠」双色 = 浅 `#2497D5` / 深 `#093592`**（源 `站标/菁悠水印.png`、`preview/assets/station-badge.png`）。
  电平表/进度/声波这类"仪器感"元件用这组渐变，别用 `#0066CC`；`--live` 只留给 ON AIR。
- ⚠️⚠️ **不锈钢一律不要拉丝**（被点名两次）＝不做拉丝纹理。抛光＝冷中性灰底 + 宽而柔斜向扫光；
  反光带窄而硬＝褶皱（小尺寸过渡宽 22→48→74、亮度 ≤ .30；站徽投影 ≤ .30）。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**；`preview/*` 只是二手还原（标"原样"的也有错）。
  判据：这个版本落过业务代码吗。提案稿未落业务代码一律不算现有。
- ⚠️⚠️ **隐私口径文案不对外**；**源码/文档/提交信息不写明文凭据**；**默认密码不设默认值**（留空随机生成 + 只首次日志打印一次）；
  **写死 bcrypt hash 等同写死密码**。
- ✅ `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）。⚠️ `${X:-兜底}` 把**空串当未设置** ⇒ 写空会静默回落。
- ✅ **MySQL `root123` 确认不改**（陛下拍板），别再去清它。

## ⚠️⚠️ 动 UI / 编内容之前
必须先读 `PROJECT-NOTES.md` 的「动 UI / 编内容之前，先读这三处源」（设计 token 源 / 真实内容源 / 结构事实源）。
两条底线：**别自起私有配色**（守 `theme.css` 三硬规则）；**别编业务事实**（站里没有 FM 频率 —— "87.6MHz"是编的，被点过）。

## 管理端小程序（分包 `pages-admin/`）
一期＝登录/待办台/投稿&点歌审核/处理台/留言审核；排期、批量、学生账号、系统设置仍在电脑端。
- ⚠️⚠️ **token 分键**（`admin_token` + `globalData.adminToken`），请求**只能用 `adminRequest()`**；共用 `token` key 会互相顶登录态。
- ⚠️ **驳回理由服务端必填** ⇒ 列表「驳回」跳处理台；留言「屏蔽」用 editable modal。
- ❌ 处理台四段（投稿人/内容/驳回/记录）**不合并**（陛下看过 v10/v11 说"先维持现状"）。
  待办台 = L1 + C 案「主浮次平」；**顶栏右侧一律留空**（微信胶囊）；标题「导播台」+「指导老师」在下面；
  ⚠️ 顶栏用 `min-height`，**不能写死 `height`**。
- ⚠️⚠️ **站徽 PNG 是透明底** ⇒ 当图标用**必须自己给 `background`**。徽章卡片形态（v13 方块/v14 正圆）**还没定**。
- 改管理端 wxss 必跑 `node preview/_check-admin-mp.cjs`（判据 `未定义 CSS 变量: 0`）。
- ⚠️⚠️ **`<text>` 保留换行** ⇒ 文案一律在 js `decorate()` 里拼好、**wxml 一行写完**。细则见 skill `wxml-render-traps`。
- ⚠️⚠️ **投影档位名 ≠ 可见度**：`--sh-card` 叠在 `#F5F5F7` 上**归零**；要浮必须 `--sh-lift` 或 `0 4px 12px -4px rgba(0,0,0,.10)`。
  交付说明**别照档位名写，采样像素**（差 <6 灰阶＝视觉上没差别）。
- ⚠️⚠️ **HTML/SVG 三个"看着像坏了"的坑**：① `<span>` 是 inline ⇒ "标题+第二行小字"一律 `display:block`；
  ② **SVG 不给 width/height 默认 300×150** ⇒ flex 行里的图标必须显式尺寸，否则同行文字被挤成竖排单字；
  ③ tabbar 的 id 是场景名不是图标名 ⇒ `ic()` 要过映射表，否则静默渲染空 SVG。

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
- ✅✅ **发布只看一条：`git push` master 即自动发布**（`.github/workflows/cloud-release.yml` + `scripts/release/*`）：verify → publish（**只发变更的那一端**）。
  ⚠️⚠️ **别再手动上传静态托管 / 别再手动部署云函数**。预检 `node scripts/release/verify.js --scope mini`（full 在本机撞垫片）。
- **线上网页** = `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`（少写 `-1491709115` 的那串返 **418**）。
  API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。
- 管理后台线上 = 静态托管（**不是**服务器 Docker）。**手搓**才用 `_hosting`：本机 `.env.local` 被 gitignore
  ⇒ 裸 `vite build` 出的是 direct 包（无 `jy-radio-`）接口必废；判据 `grep -oh jy-radio- _hosting/assets/*.js` 必须命中。
- ✅ 静态托管两必配已完成：① SPA fallback ＝ 静态网站托管→基础配置→**路由配置**→错误码 404 替换 `/index.html`（**内部重写 200**，不是 302）
  ② 域名进 HTTP 网关→跨域设置。
- ⚠️⚠️ **首次打开弹「风险提醒」中间页**（404 + `<title>风险提醒</title>`）**不是部署坏了**：点「确定访问」即进（8h 不再弹）。
  ⇒ 探测必须带**浏览器同款请求头（含同域 Referer）、只用 Node `https`**（curl 会得出反向结论）。细则 `cloud/docs/final-cutover.md` §②-b-1。
- ⚠️⚠️ **⑧ 的卡点是开关**：`requestMode` 已改 `'cloud'`；**只改代码不重新上传＝没生效**，**必须用微信客户端验**。
  ⇒ **学生走小程序（免备案）/ 老师走 admin-web ＝两条独立的线，别混谈。**
- ⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖 —— 排查"通道不对"先查它。切云后学生侧**无兜底**。
- ⚠️⚠️ **`jyradio.online` 未备案**（TLS 被 RST；**证书 ≠ 备案**）。云开发备案 3 准入：套餐≥个人版 + 剩余 > 6 个月 + 已开云托管固定 IP。
- ✅ **服务器上那份 admin-web 已下线**（`5805b6d`）⇒ 管理后台只有静态托管一份；"改完看不到"**先问地址栏**。

## 伙伴端 v19：站员端四模块（2026-10-12 陛下，最新口径）
- 站员底部**四个模块：工作台 / 稿件 / 班表 / 我的**（带待办红色角标 `.bg`）。
- **首页＝欢迎区 + 大白卡「正式值班安排」+ 需要你处理**（参考图照做）：欢迎区 = 站名·站员 + 「X，你好。」+ 淡校园线描 SVG 水印；
  大白卡 `bigc.float` 下方两个链接（填写可排时间 / 查看班表）；需要你处理 = 编号 01/02 + 彩色点标签（蓝=可排时间 / 琥珀`#C97A00`=退回修改）+ 标题 + 说明 + `›`；再一条版本记录提示行。
- **稿件 tab = `my-drafts` 升成 tab 页**（nav「稿件」、tab `my-drafts`），页首 AI 找稿 + 继续写（**仅站员端渲染**——社干/超管没这两屏，别留死链）。
- **我的 = 个人介绍 + 可排时间 / 考勤 / 请假进度 + 底部退出登录**（`.btn.block`，白底 hairline 红字；别用 actbar 否则 dock 会被收走）。九宫格/设置项一律不做。
- ⚠️⚠️ **大白卡要自己给投影**：Codex 层把 `--sh-lift` 设成 none、`--sh-card` 叠 `#ECECEF` 归零 ⇒ 用 `.float{box-shadow:0 10px 26px -14px rgba(0,0,0,.30),0 3px 8px -5px rgba(0,0,0,.08)}`。
  判据（**采样像素，别看档位名**）：卡下缘外 1px 与页面底色差 **≥6 灰阶**（v19 实测 14）。
- 页脚 `accountFoot` 已删「帮助与反馈 / 关于伙伴端」，只留退出登录。
- 屏数 **50**（站员 12 / 社干 17 / 超管 21）。**社干端/超管端仍维持 v18 两 tab**，等陛下指令。

## 伙伴端 v18：删「我的」「更多入口」+ 功能重分类（2026-10-12 陛下）
- 三端**不再有「我的」和「更多入口」**（功能与工作台/审核重复）⇒ 底部导航只剩两 tab：
  站员 工作台/班表 · 社干 工作台/审核 · 超管 工作台/班表。**屏数 51 → 49**（删 6，补 4）。
- 重分类落点：帮助/关于/退出 → 三端**工作台页脚** `accountFoot()`；**我的稿件** → 页脚首行
  （社干/超管也要注册 `my-drafts` + `versions`，本人也写稿）；**伙伴名册 + 导出本周班表** → 班表页；
  公告发布 / 模块开关 / 系统设置 / 数据看板 / 批量导出 → 判为**电脑端后台**，超管管理块下 `.cp-note` 说明行、不留入口。
- ⚠️⚠️ 改场景必跑**死链探针**（逐角色逐场景渲染、收集 `#view [data-go]` 比对该角色 SCENES）——
  v18 首轮抓出 `my-drafts→versions` 未注册、`roster→undefined`（`navRow` 少传 go 的老 bug，改 `rowItem`）。
  修完 **ok=84 / bad=[]**。

## 伙伴端三端定案（2026-10-10 陛下逐条给，v7/v8/v10 落地）
> ⚠️⚠️ **详细场景清单在 `preview/partner-hub-gounucai-v11/app.html`**（线上为 v5 目录，发布前 cp 回 v5）。

**站员端（v7）**
- 首页＝工作台：**欢迎卡**（5–11 早上好/11–13 中午好/13–18 下午好/其余晚上好，`new Date().getHours()` 判，别写死）+ 日期 + 今天该我哪一场。
- 工作台 **5 入口**：我的稿件/考勤/请假申请/**互评**/站内公告，每行一句真实状态。底部 tab 3 个：工作台/班表/我的。
- **班表＝周表格**：列＝周一~五（带日期），行＝早会/午间/下午；⚠️ **一个时段可多人**（午间常两人搭档）⇒ 格子竖向排「名字胶囊」，一人一个自带状态色
  （我·浅蓝 / 请假待批`#FDF3DC` / 已批准`#EAF7EF` / 空缺虚线）+ 图例；下面接 申请请假 → 我的请假 → 本月场次 → 可排时间填报入口。
- **「当场反馈」已改名「互评」**：显示今天日期时段 + 今天在台上的人，点谁进谁评语框（`S.fbWho` 切换）。
- 我的稿件：筛选胶囊带计数 + 每条一个胶囊卡。请假申请：**不要顶部"本月还能请几次"卡**。新增 我的考勤 / 站内公告 两屏。
- ⚠️ **不要权重**（陛下：「不要权重了，直接去掉」）⇒ 简介/欢迎卡/我的/超管排班规则/账号分发宫格**全删**。
  排班顺序改口径：**场次少的、最近没排的、上次值班更早的优先**。
- ⇒ 社干端/超管端 **还没过**，等陛下下一条指令再动，别自己顺手改。

**社干端（v8）**
- 待办台→**工作台**；底部 tab 3 个：工作台/审核/我的。工作台＝**听众投稿**（点歌/文稿/留言审核）+ **站内协作**（内部稿件/请假审批/岗位补位）+ 考勤录入 + 班表。
- ⚠️⚠️ **「按现有的 X 来做」＝去读项目里那份真实文件**（曾被问"审核模块有没有按照现有的处理台来做"，我照自己原型画，缺了 7 项）。
  **真实处理台 ＝ `miniprogram/pages-admin/review-detail/`**，**四段不合并**：
  ① 队列导航「‹ 上一条 / 第 N / M 条待处理 / 下一条 ›」② 投稿人卡（首字头像 + 学号/班级 + chip + 历史通过/驳回/首次投稿）
  ③ 投稿内容（写全不截断）＋ **处理结果·本周名额**（仅点歌：used/limit + 进度条 +"通过会占用一个名额（日+周各一个）"）
  ④ 驳回原因**必填**：预设胶囊 5 条（内容不适合播出/重复投稿/信息不完整/歌词内容不适宜/该曲一周内已点过）+ 警示行（未填时「驳回」不可点）
  ⑤ 审核记录：**没处理过就直说"本条目尚未处理"，不编造**。底部固定条：驳回 / 通过并取下一条。
  队列页（`pages-admin/review/`）：筛选胶囊带计数；**待审条目右边直接带「通过/驳回」**，不必点进去。
- 考勤录入：顶部五天五个胶囊 → 当天按时段列该到的人（**可两人**）→ 人人三态 到/假/缺 → 保存。
- 请假审批：**去掉顶部卡**，第一块直接申请详情 + 批准后班表预览 + 批准/驳回。
- 班表（社干）：周表格（全体）+ 排班入口就在班表里。草稿与调整：每时段一卡、卡里人选胶囊、**点名字＝锁定**（重生成草稿不动）、「＋加人」；⚠️ 也必须支持一时段多人。
- 我的（社干）：工作证 + 伙伴名册 / 我的出勤 / 我的稿件 / 设置 + 帮助/关于/退出。
- **站员名册 → 伙伴名册**（全站统一叫法）：导入(xlsx)/导出/勾选批量删除；姓名+年级班级+联系方式；**社干也写进名册**（标"社干·岗位"）。
- 岗位补位（新页）：缺岗列表（哪个时段/缺几人/为什么）+ 按可排时间筛过的候选人 + 确认补位。

**超管端（v10）**
- ⚠️ 超管**具备社干端所有功能** ⇒ 用**共享注册**：`SCENES.push({…,role:'super'})` 批量复制 14 个场景（attendance/mgr-schedule/planning/draft/workload/history/leave-approve/fill/submissions/submission-detail/messages/review/song-schedule/roster），`tab` 重挂 `desk`/`me`。**别逐个手写**。
  ⚠️ 坑：共享列表里**不要带 `more`**（超管本来就有 → 重复一项）。
- 底部 tab 3 个：工作台/班表/我的 ⇒ `accounts / timeslots / rules` 的 `tab` 全改 `desk`，否则返回箭头与 tabbar 高亮失效。
- 工作台＝欢迎卡 → **管理块（账号/排班规则/考勤总览，标"超管独有"放最前）** → 听众投稿 → 站内协作 → 考勤录入/班表。
- 工作台两区块＝**三联卡**（名称蓝 + 待处理大数字 + 「进入处理 ›」）；⚠️ 站员端仍是「胶囊行」，**只有社干/超管端是三联卡**。
- ⚠️ **问候卡三个身份都要有**（曾漏社干端 —— 陛下点名）判据：`grep -c "hi\">'+greet" app.html` = **3**。
- 账号宫格 5 项：分发账号/批量重置/导入名单/删除账号/停用账号。排班规则页内含「发布值班时段」。
- 考勤总览（超管独有）：本周场次/应到人次/实到/请假 + 全站出勤率 + 每人一行（到场数+出勤率）。

## ⚠️⚠️ 伙伴端视觉基准 = Codex（2026-10-10 陛下：「所有的 ui 界面很乱，去看看 codex 的按照它那个设计来」）
**基准**：`preview/partner-hub-codex-v2/`（`style.css`/`portal-shell.css`/`work/review-desk.css`/`work/manager-dashboard.css`）。**只学样式，内容一字不改。**
**落点**：`preview/partner-hub-gounucai-v11/app.html` 末尾「Codex 视觉语言覆盖层」（≈250 行，类名/DOM 零改动）。
语言（逐条，别再自己发明）：
① **全部去投影**（`--sh-lift:none`）—— 最大差异。② **页面底更灰** `#ECECEF`，卡片**纯白 + 18px 圆角**，卡内次级块 `--paper #F5F5F7`。
③ **列表 = 白卡容器 + 卡内细线行**（`.row{border-top:1px solid var(--line)}`，首行无）—— **不是"一行一个独立胶囊"**（上版就栽在这）。
④ **状态 = 小方角灰块**（7px 圆角/10px/`#E8E8ED`），不是彩色胶囊；或 Codex `.state`（4px 圆点 + 文字）。
⑤ **分段 = 深灰凹槽 + 白色凸起**（`.seg{background:#E8E8ED;border-radius:13px;padding:4px}`，选中 `#FFF`+accent 字、10px 圆角），不是胶囊组。
⑥ 按钮 `13px` 圆角 + `min-height 44~46px`；次要按钮 `--paper` 灰底。⑦ 字号整体下调、行高放松（页标题 26–27/600、段标题 14–15、正文 13、说明 11–12、行高 1.8–1.95）。
⑧ 图标底＝方形 10px 圆角 + 灰底（`.gcell{background:var(--paper);border-radius:14px;min-height:82px}`）。
⑨ 手机壳＝真机感黑边（`border:7px solid #29292B;border-radius:45px`）。⑩ 底部 tabbar＝**浮动白胶囊 dock**（圆角 34/边框/选中块填色）。
  ⚠️ Codex 这里是**深色**选中块 —— 按「不要深色」改成 `--accent` 蓝。
⑪ ⚠️ **没搬它的场景入场动画**（`.scene{animation:appear}`）：`--virtual-time-budget` 不推进 CSS 动画 ⇒ **截图拍到全空页面**（踩过）。
⑫ **底部导航与操作条都是"悬浮"的**（源 `scheduling/schedule-content.css` 的 `.phone-nav`/`.mobile-actionbar`/`.home-indicator`）：
  `.tabbar{position:absolute;z-index:30;bottom:20px;left:16px;right:16px;min-height:64px;border:1px solid #E6E6EA;border-radius:34px;padding:5px}`（选中块圆角 28）；
  `.actbar{position:absolute;z-index:31;bottom:96px;left:16px;right:16px;border:1px solid #E6E6EA;border-radius:18px;padding:8px}`；`.homebar` 120×4 深色 bottom:7px。
  内容区留白 `.view{padding:14px 22px 112px}`，含 `.actbar` 的页 `padding-bottom:190px`。
  ⚠️⚠️ **`.layer` 必须是 `position:static`**：一旦 relative 就成了 `.actbar` 的定位祖先 ⇒ 操作条跑到内容末尾（实测差 373px）。
  判据：`actbar` 距手机底 **103px**（96+7 边框）、`dock` 距手机底 **27px**（20+7）。
⑬ **二级页自带操作条 ⇒ 底部导航下滑收走**（v13/v14）：渲染出 `.actbar` 时给 `.tabbar` 加 `.away`（`translateY(calc(100% + 30px))` + `transition .28s`）。
  **v14 追加：操作条自己接管导航位置** —— `.actbar` bottom 96→**20px**（留白 190→140）、进页向上滑入（`.pre` 起点在屏下 + reflow 去类触发过渡；
  `renderPhone.last` 记场景，**只在场景切换播**，同页勾选 re-render 不重播）、退页向下滑出（`ghostBar()` 克隆成 `.ghost` barDown .25s，320ms 后移除）。
  判据：`grep -c "actbar.ghost\|ghostBar" app.html` ≥4。
  **v15–v17 追加（胶囊化三连）**：操作条容器+按钮全圆 9999px；单按钮条（`:not(:has(.btn2))` 判定，勿用 :only-child——
  隐藏说明行是兄弟节点会误判）去白壳、纯色胶囊直接落底；ghost/danger 白底+hairline 描边；
  **所有操作条按钮锁死 `margin:0;box-sizing:border-box;height:56px`，btn2 用 `grid 1fr 1fr`，壳 min-height 72**。
  ⚠️⚠️ 大小不一的真凶：基础样式 `.btn+.btn,.btn2{margin-top:9px}` 给按钮组第二个按钮偷加 9px（v17 才抓到）——
  改按钮组先 grep 全部 .btn 联动规则。判据：两按钮 rect 159.5×56.0、top 同线。
**怎么看 Codex 原型**：`index.html?view=backdrop-v21#<场景>`，用 **`file://` 直接开**（起 http server 会被回收，Chrome 会 `ERR_CONNECTION_REFUSED`）。
手机内的独立页面：`work/index.html`、`scheduling/index.html`。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。⚠️ **`git pull` 不影响运行中的容器** → 一次性脚本用 `docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。
- 加列/加索引顺序与坑见 skill `sequelize-schema-rollout`：备份 → build → `scripts/db-repair.js` → up → 回填 → `queue/sweep`。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。

## 本机坑
- ⚠️⚠️ **给陛下的命令**：本机 PowerShell → `C:\` 路径、**无 `&&`**、无 `tail`；服务器 bash → `cd ~/radio`、`&&`、管道随便用。**两段必须是两个独立代码块**。
  ⚠️ **不给需要交互输入的命令**；**必须给判据行**。
- ⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。PowerShell stdout 不回显 → 落盘再 Read。
- **改前端先跑**：`scripts/check-vue-bindings.js`、`scripts/check-wxml-classes.js`（判据＝ missing 有没有列名字）。
- ⚠️ 深色卡尾部提示被 flex-shrink 压扁 → 改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`，判据量 height。
- ⚠️⚠️ **vite 构建到"已存在"目录会被 safe-delete 垫片拦**（拦删不是代码错）⇒ 构建到**不存在的新目录**（`--outDir _hosting`）。
- ⚠️ `admin-web/package.json` 有 `"type": "module"` ⇒ 临时脚本用 **`.cjs`** 后缀。
- 不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；admin-web 走 vite dev（`/submit/settings`）。
  ⚠️ 复用服务**会跨会话掉线** → 截图前探活；**`_shot.db` schema 变过要先 `rm`**。
- jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
- ⚠️⚠️ **push 本机做不了（别再试）**：GCM 取不到凭据、`gh` 未装 ⇒ commit 我负责，**push 陛下自己敲**。判据 `git status -sb` 里**没有 `ahead N`**。
- ⚠️⚠️ **部署云函数本机做不了**（沙箱拦 `reg.exe`）⇒ **陛下自己跑**。CLI `D:\dev\wx-devtools\cli.bat`。
- ⚠️ PowerShell `Add-Type` 被拦 → 图像处理走 Python venv `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`。
- 截图见 skill `web-ui-screenshot-verify`：⚠️ 会话跑久 / `location.href` 导航必出空白页（截图恒 3680 字节）→ 换 `--session <独立名>`。
  ⚠️ agent-browser 可能 EBUSY → 改用 Chrome 无头。⚠️⚠️ `--virtual-time-budget` 不推进 CSS 动画 ⇒ 验中间帧要让页面自己定格。
  ⚠️⚠️ **Chrome 无头最小视口 ≈512**：`--window-size=390` 截出来是 390 宽但布局按 512 算 ⇒ 右边被裁，**看着像"手机端溢出"，其实是假的**。
  要测真手机宽：造 390 宽的 iframe 包住目标页 + `--allow-file-access-from-files`，读 `contentDocument.documentElement.scrollWidth` 比 `clientWidth`。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 图标必须已 import。**三维状态保持数字**；数字↔常量名只许在 `songStatusService` 定义。
- **新开关不进 `seed.js`**（switch.test 断言恰好 4 条）→ 走 `switchService.KNOWN_SWITCHES`；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**（`create_time ASC, id ASC`）。⚠️ **老服务器 ↔ 云库会分叉**：一边改的密码另一边不知道。

## 启动动画素材（v4 零件，等点头）
- 站徽底稿 1410×1410，**圆心＝图心 (704.5, 704.5)**；深蓝 `#093592` / 浅蓝 `#2497D5`。环字：中文 5 字顺时针走**顶**、英文 18 字母逆时针走**底**，两行都西起东收。
- 零件在 `preview/launch-v4/assets/`（80 PNG + `parts.json`/`arcs.json`/`sprite.png`+坐标表）。
  ⚠️ 切图统一 **`alpha > 0`**（`alpha>100` 会丢抗锯齿边 → 外环少 6.6%）；⚠️ 校验要按清单 `(x,y)` **平移回绝对坐标**。细则见 skill `bitmap-logo-split-animate`。
- ✅ 线上 `miniprogram/components/launch-mask/` **仍是 v1，一个字没动**。等陛下在 `preview/launch-v4/index.html` 点头。
