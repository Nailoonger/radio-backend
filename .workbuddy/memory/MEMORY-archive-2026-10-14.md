# 菁悠广播站 · 项目长期备忘（精简版）

> 本文件只留**铁律 + 判据**，避免超限被截断。细节全文：
> `MEMORY-archive-2026-10-12.md`（压缩前完整版，含各版本逐条）· `PROJECT-NOTES.md` · `docs/` · `cloud/docs/final-cutover.md` · 各 skill。

## 铁律
- **只做加法**：`src/`+`admin-web/`+Docker 一行不删，保留 `requestMode:'direct'|'cloud'`。**绝不用 `git checkout --`**。
- UI/视觉**先出带版本号的静态预览，点头前不写业务代码**；版本只增不删；被否先问清形态，别偷偷捡回。
  ⚠️⚠️ **复制目录做新版本后第一件事：改"页面上给人看的版本号"**（title + 页内文案），否则陛下判定"没更新"。
  判据 `grep -o "v<N-1>" 新目录/*.html` = 0（⚠️ SVG path 里的 `v14` 画线指令会误报，要人工看一眼）。
- ⚠️⚠️ **不许通用范式**（"换给别的 App 也成立"＝没做）→ 从业务隐喻长出来（已用：调频刻度、录音电平、收听证钢印、骑缝孔、唱针、校园校舍）。
- ⚠️⚠️ **不要深色——任何形式**（点名三次）❌深色药丸/卡/面板/横幅/浮层。✅白卡 + 深色字 + 羊皮纸底；选中态 `--accent-tint` 底/`--accent` 字；主按钮 `--accent`。
  判据 `grep -c "var(--tile)" 页面` = 0。改浅色最易漏：站徽白底、`rgba(255,255,255,x)` 文字、SVG 硬编码刻度色、**文案自称"深色卡"**。
- **手机里不要装饰性描边框**；留=有状态含义（已选/focus/`.slot.mine`），演示标注一律加在手机外。
- 「四层纵向单列」**只用于「我的」一屏**；其余页各按自己的信息排，不套统一模板、不强制"每页三个数"。
- **圆角胶囊**：单行元素 9999px；内容卡片 18px（Codex 层）／28px（旧口径）；卡片上 9999px 会变橄榄球（实测）。
- ⚠️⚠️ **线上站点目录 = `preview/partner-hub-gounucai-v5/`**（分享链接绑死这个目录）⇒ 新版本成果**先 cp 回 v5 再发布**，否则会新建 app 给新链接。
- 学生登录页**不再有微信登录**（2026-10-02 拍板），以后不做相关入口/接口。
- 站徽「菁悠」双色 浅 `#2497D5` / 深 `#093592`（仪器感元件用这组，别用 `#0066CC`）；`--live` 只给 ON AIR。
- **不锈钢禁拉丝**（点名两次）；抛光＝冷中性灰底 + 宽而柔斜向扫光，反光带窄硬＝褶皱。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**（`preview/*` 是二手还原，标"原样"的也有错）。判据：这版落过业务代码吗。
- 隐私口径文案不对外；源码/文档/提交信息**不写明文凭据**；默认密码不设默认值（留空随机 + 首次日志打印一次）；写死 bcrypt hash＝写死密码。
- `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）；`${X:-兜底}` 把空串当未设置 ⇒ 写空会静默回落。MySQL `root123` 确认不改。

## ⚠️ 动 UI / 编内容之前
先读 `PROJECT-NOTES.md`「先读这三处源」（设计 token / 真实内容 / 结构事实）。底线：**别自起私有配色**、**别编业务事实**（站里没有 FM 频率）。

## 伙伴端最新口径（v25，2026-10-12 陛下）
- **社干端＝五模块：工作台 / 审核 / 稿件 / 班表 / 我的**（角标 3/8/1/0/1）。
  工作台＝站员同款（`homeTop()` 助手：通栏欢迎带 + 大白卡 + 需要你处理＝待审稿件/请假审批/岗位补位）＋听众投稿·站内协作三联卡 + 考勤录入行；
  **稿件＝与站员同功能**（AI 找稿 + 继续写 + 我的稿件 + 版本 + 导出）；**班表＝`mgr-schedule`**（排班入口就在班表里）；
  **我的**＝互评 / 可排时间 / 请假进度 / **我的考勤（「本月 7 / 8 场 · 只看不录」——必须与「考勤录入」区分）** / 伙伴名册 + `.btn.block` 退出登录。
- **审核页＝三段（点歌 / 文稿 / 留言）+ 下级圆角胶囊（全部 / 待审 / 已通过 / 已驳回）**；`.pills`＝白胶囊容器 + 选中填 `--accent`（与底部 dock 同语言）。
- **分段控件（v28/v29）＝全圆胶囊 + 按钮 `flex:1` 填满轨道**（灰槽 + 白色选中药丸 + accent 字 + 抬起投影）——
  ⚠️ 不填满就留一大片白（陛下：「留着停航母吗」）。与下级胶囊几何对齐（4px 内衬 / 40 高）。
- ⚠️⚠️ **全屏对齐审计（v29 起必跑）**：`node _opfit/audit.cjs <版本目录>` —— 逐角色逐场景量 ①顶层块左/右边界 ②容器内末元素距右沿空档（`.seg/.pills/.mods/.grid/.stats/.td/.wk-grid/.days`）③相邻块纵向间距。
  **基准**：`.view` 内缩 22px；卡内基准 **16px**（`.rows` 卡即 `padding:0 16px`）⇒ **嵌套在卡里的 `.rows` 横向内缩必须为 0**；`.blk` 内缩一律 16px。
  白名单（有意不齐）：`wel`（通栏出血 −22px）、`actbar`（悬浮条内缩 16px）、宫格最后一行不满。纵向节奏主流 **12px**。
- ⚠️⚠️ **两个必跑审计（v31 新增）**：`node _opfit/overflow.cjs <目录>`（逐屏扫横向溢出/越界；白名单 `wel`/`layer`＝通栏带+素描图层故意出血）· `node _opfit/vars.cjs <目录>`（扫「引用但未定义」的 CSS 变量）。
  **血泪根因**：`--line` 被引用 25 次却从未定义 ⇒ 所有描边/分隔线静默失效（「边框缺失」的真凶）；缺的还有 `--paper`(12) `--tint`(2) `--danger`(3)。**改 CSS 前先跑 vars**。
  ⚠️ **完整时间段不能塞窄列** ⇒ 溢出。窄位（班表行头/请假表单/请假审批/考勤行/岗位补位）用**起点时间**（`早会 06:50`），完整区间只留在「可排时间」页（两行胶囊）与说明文案。
- **筛选胶囊（v30）**：**独立成行、不要外层背景卡、不要统计数字**（陛下点名）；去卡后灰槽在灰底上看不见 ⇒ `.seg` 加 `inset 0 0 0 1px #DEDEE4`。
- **考勤五天（v30）＝五个独立方块**（gap 10、各自白底+描边+抬起投影、min-height 68、radius 16）——不要挤在一个胶囊条里。
- ⚠️⚠️ **Codex 覆盖层会把组件的 border 抹成 0**（`.pick/.slot/.mk button{border:0;background:var(--paper)}`）⇒ 在白卡里看着没边框。要边界就白底 + `box-shadow:inset 0 0 0 1px var(--line)`（人名胶囊/时段胶囊都这么修）。
- **时段时间（v30 定稿）**：早会 **06:50–07:30** · 午间 **12:10–12:30** · 下午 **17:40–18:10**（由社干发布）。可排时间页＝**两行胶囊**（时段名 + 时间）；班表行头/请假表单用**起点时间**（`早会 06:50`）避免折行。
- ⚠️ **改数据结构要同步改渲染**：`[[点歌,5]]` → `[点歌]` 后渲染仍取 `p[0]` ⇒ 只显示首字。⚠️ **兜底全局替换会误伤刚写的文本**：`12:30→12:10` 把 `12:10–12:30` 扫成 `12:10–12:10`（13 处）⇒ 兜底后必须复查目标字符串完整性。
- ⚠️ 陛下口述的「站员名册」仍按早前定稿叫**伙伴名册**（他没让改回，别自作主张）。⚠️ 超管端仍两 tab、稿件页不给找稿入口，等指令。
- 屏数 **57**（站员 12 / 社干 24 / 超管 21）。
- **底部角标（v26 规则化，唯一数据源 `TODO`）**：角标＝**归该 tab 管的未处理件数**（每条 `{t,x,m,go,tone,n,owner}`，`n`＝件数）；
  **同一件事只归一处**（不再两 tab 同亮）·**归零即隐**·**>99 显示 `99+`**·**班表查看型永不亮**。
  口径：工作台＝要你动手的件数 · 稿件＝稿件自身状态 · 我的＝个人事务进度 · 审核＝待审条数。
  页面「需要你处理」与 dock 角标**同源**（`todoHome()` / `tabBadge()`），改数字只改 `TODO` 一处。
  ⚠️ **角标位置**：必须锚在**图标框**上（dock 里给图标包 `.iw`，角标 `top:-4px;left:100%;margin-left:-8px` ⇒ 与图标重叠 8px、高出 4px）——
  用 `left:50%+margin` 从 tab 中线偏移会随 tab 宽度飘走（v26 踩过）。
  ⚠️ 工作台 tab id 站员端是 `home`、社干端是 `desk` ⇒ `tabBadge` 里要归一逻辑键，否则社干工作台不亮。

## 伙伴端站员端口径（v19–v24）
- **站员端底部四模块：工作台 / 稿件 / 班表 / 我的**（tab 带待办红色角标 `.bg`；社干见上节五模块）。
  · **首页**（参考图）= 欢迎区（站名·站员 + 「X，你好。」+ **院校插画通栏背景带**）+ **大白卡 `bigc.float`（正式值班安排）** + 「需要你处理」（编号 01/02 + 蓝点=可排时间 / 琥珀 `#C97A00`=退回修改 + 标题 + 说明 + `›`）。
  · 背景图：**欢迎卡＝照 Codex 原做法**（源 `preview/partner-hub-codex-v2/work/workbench-cards.css` 的 `.workbench-welcome`，**逐值照搬**）：
    通栏带 `background:#F5F5F7` + 直角 + 负边距铺满 + `padding:20px 22px 48px`；校舍图＝**右下角伪元素图层**
    （`right:-34px;bottom:0;width:282px;max-width:82%;height:160px`、`right 42%/330px auto`、`opacity:.27`、`mix-blend-mode:multiply`、
    双层遮罩 `linear-gradient(90deg,transparent 0,#000 68%) ∩ linear-gradient(180deg,#000 60%,transparent 100%)` + `mask-composite:intersect`）；
    `> * {position:relative;z-index:1}`；**第一张卡 `margin-top:-24px` 压住带子下沿** + `.bigc{border-radius:20px;padding:18px}`；
    字号按 Codex：眉题 11/1.6 · 标题 22/1.4/ls-.4 · 说明 12/1.8。素材 `assets/campus-building-panorama.png`（线描，灰度+量化 147KB）。
    ⚠️⚠️ 被否五次的经验：v20 太淡 · v21 边角硬 · v22 图与卡片同宽「像盒子」· v23 通栏带（对但不完整）· **v24 照 Codex 定稿**——
    结论：**"像背景"靠的是「带子铺满 + 卡片压边 + 图只做低透明图层」，不是把图放大**；线描才扛得住 .27 multiply（彩图会糊）。
  · **稿件 tab = `my-drafts` 升 tab 页**，页首「AI 找稿 / 继续写」**仅站员端渲染**（社干/超管没这两屏，别留死链也别自行加屏）。
  · **我的** = 个人介绍（hero.float）+ 可排时间 / 考勤 / 请假进度 + **互评 / 站内公告**（v21 从首页移入）+ 底部 `.btn.block` 退出登录（白底 hairline 红字；别用 actbar 否则 dock 被收走）。九宫格/设置项一律不做。
- **大白卡要自己给投影**（Codex 层 `--sh-lift:none`、`--sh-card` 叠 `#ECECEF` 归零）：`.float{box-shadow:0 10px 26px -14px rgba(0,0,0,.30),0 3px 8px -5px rgba(0,0,0,.08)}`。
  判据**采样像素**：卡下缘外 1px 与页面底色差 ≥6 灰阶（v19 实测 14）。
- 页脚 `accountFoot` 已删「帮助与反馈/关于伙伴端」，只留退出登录。**社干端/超管端仍维持 v18 两 tab**，等指令。
- 屏数 **50**（站员 12 / 社干 17 / 超管 21）。**社干端/超管端待陛下重做**。
- v18 结论（仍有效）：三端原「我的」「更多入口」已删（功能重复）；伙伴名册 + 导出班表落在**班表页**；公告发布/模块开关/系统设置/数据看板/批量导出＝**电脑端后台**（超管工作台 `.cp-note` 说明行，不留入口）。

## 伙伴端旧口径（v7/v8/v10 定案，细节见归档）
- **站员**：班表＝周表格（列周一~五带日期，行早会/午间/下午），**一个时段可多人**、一人一颗名字胶囊自带状态色（我·浅蓝/请假待批`#FDF3DC`/已批准`#EAF7EF`/空缺虚线）+ 图例。「当场反馈」已改名**互评**。⚠️ **不要权重**——排班顺序＝场次少的、最近没排的、上次值班更早的优先。
- **社干**：工作台＝听众投稿（点歌/文稿/留言）+ 站内协作（内部稿件/请假审批/岗位补位）+ 考勤录入/班表。⚠️⚠️ **「按现有的 X 来做」＝去读真实文件**：**真实处理台 = `miniprogram/pages-admin/review-detail/`**，五段（队列导航 / 投稿人卡 / 内容+本周名额 / 驳回原因必填 5 预设+警示行 / 审核记录"没处理过就直说"），**四段不合并**；队列页待审条目右边直接带通过/驳回。考勤录入＝五天胶囊 + 人三态。伙伴名册＝导入/导出/勾选批量删，社干也写进名册。
- **超管**：具备社干全部功能 ⇒ **共享注册** `SCENES.push({…,role:'super'})` 批量复制（列表里**别带 `more`**）；工作台多「管理」块（账号/排班规则/考勤总览）；两区块＝**三联卡**（站员端是胶囊行）；**问候卡三个身份都要有**，判据 `grep -c "hi\">'+greet"` = **3**。

## 伙伴端视觉基准 = Codex（`preview/partner-hub-codex-v2/`，只学样式）
全部去投影 · 页面底 `#ECECEF` · 卡片纯白 18px · **列表＝白卡容器+卡内细线行**（不是一行一胶囊）· 状态＝小方角灰块/圆点 ·
分段＝深灰凹槽+白色凸起 · 按钮 13px/44–46px · 字号下调行高放松 · 图标底方形灰块 · 手机壳黑边 7px ·
tabbar＝**浮动白胶囊 dock**（选中块用 `--accent`，Codex 原为深色）· **不搬场景入场动画**（`--virtual-time-budget` 不推进 ⇒ 截图全空）·
**`.layer` 必须 `position:static`**（否则是 `.actbar` 定位祖先，操作条跑内容末尾，实测差 373px）。
操作条（v13–v17）：有 `.actbar` ⇒ dock 加 `.away` 下滑收走；**操作条接管底部位置 bottom:20px**，进页向上滑入（`renderPhone.last` 只在场景切换播）、退页 `ghostBar()` 下滑出；
容器+按钮全圆 9999px；单按钮条（`:not(:has(.btn2))`，勿用 `:only-child`）去白壳；ghost/danger 白底+hairline；
**按钮锁死 `margin:0;box-sizing:border-box;height:56px`，btn2 `grid 1fr 1fr`，壳 min-height 72**。
⚠️⚠️ 大小不一真凶：基础样式 `.btn+.btn,.btn2{margin-top:9px}`（v17 才抓到）——改按钮组先 grep 全部 `.btn` 联动规则。
**怎么看 Codex**：`index.html?view=backdrop-v21#<场景>`，用 `file://` 直接开（http server 会被回收）。

## 自检工具（每次改场景/样式都跑）
- ⚠️⚠️ **死链探针**：逐角色逐场景渲染，收集 `#view [data-go]` 比对该角色 SCENES ⇒ 必须 `bad=[]`（v18/v19 各抓出真 bug）。
- **投影/颜色判据一律采样像素**（差 <6 灰阶＝看不出）；**尺寸判据量 rect**（如两按钮 159.5×56.0、top 同线）。
- 探针副本**必须与交付稿同目录**（否则 `assets/` 解析错）；**改完主文件要重新生成探针**（否则截到旧稿得出"图像没变"假象）。
- 无头截图：`--headless=new --disable-gpu --allow-file-access-from-files --window-size=780,1900 --virtual-time-budget=4000`；⚠️ 最小视口 ≈512（`--window-size=390` 会假溢出）。

## 管理端小程序（分包 `pages-admin/`）
一期＝登录/待办台/投稿&点歌审核/处理台/留言审核；排期、批量、学生账号、系统设置仍在电脑端。
⚠️⚠️ token 分键（`admin_token` + `globalData.adminToken`），请求只能 `adminRequest()`；驳回理由服务端必填（列表「驳回」跳处理台）。
顶栏右侧一律留空（微信胶囊）、用 `min-height` 不能写死 `height`；站徽 PNG 透明底 ⇒ 当图标必须自己给 `background`。
改 wxss 必跑 `node preview/_check-admin-mp.cjs`（判据 `未定义 CSS 变量: 0`）。
⚠️⚠️ `<text>` 保留换行 ⇒ 文案在 js `decorate()` 拼好、wxml 一行写完（skill `wxml-render-traps`）。
⚠️⚠️ 投影档位名 ≠ 可见度（`--sh-card` 叠 `#F5F5F7` 归零）。
⚠️⚠️ HTML/SVG 三坑：`<span>` 是 inline（标题+副行一律 `display:block`）；SVG 不给尺寸默认 300×150（flex 行图标必须显式尺寸）；
tabbar id 是场景名 ⇒ `ic()` 要过映射表。

## 云开发（`cloud/` 阶段 0–9，回归 3115 项 0 失败）
源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。⚠️ Windows CLI 传子目录必坏 ⇒ 打**单文件**，`handlers/index.js` **静态注册表**。
部署 `node cloud/scripts/deploy-cloud.js` → 手动 cli.bat → 等 1~2 分钟。
口径：业务查询用数字 `id`；4 张表业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段驼峰；`insertOne` 后改这行用返回的 `_id`。
⚠️⚠️ 切云弄坏上传类接口（信封 JSON ⇒ `FormData` 变 `{}`，40001）：契约 `{filename,fileBase64}`，凡 FormData/Blob 切云后必须单验。
⚠️⚠️ 学生初始密码＝`user`+学号（唯一出口 `studentAccountService.initPasswordFor()`；初始 cost 8、改密后 10）；管理端 DTO 字段是 `activated`。

## 发布 & 真机收尾
✅✅ **发布只看一条：`git push` master 自动发布**（`.github/workflows/cloud-release.yml`）：verify → 只发变更那端。**别再手动上传静态托管/部署云函数**。预检 `node scripts/release/verify.js --scope mini`。
线上网页 `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`（少 `-1491709115` 返 418）；API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。
管理后台线上＝静态托管（**不是**服务器 Docker）。手搓才用 `_hosting`（裸 `vite build` 出 direct 包必废，判据 `grep -oh jy-radio- _hosting/assets/*.js` 要命中）。静态托管两必配已完成（SPA fallback 404→`/index.html` 内部重写 200；域名进网关跨域）。
⚠️⚠️ 首次打开弹「风险提醒」中间页**不是部署坏了**（点「确定访问」即进 8h）；**探测必须带浏览器同款请求头 + Node `https`**（curl 会得反向结论），细则 `cloud/docs/final-cutover.md` §②-b-1。
⚠️⚠️ ⑧ 卡点是开关：`requestMode` 已 `'cloud'`，**只改代码不重新上传＝没生效，必须用微信客户端验**；学生走小程序（免备案）/老师走 admin-web 两条独立线。
⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖。`jyradio.online` **未备案**（证书 ≠ 备案）。
✅ 服务器上那份 admin-web 已下线 ⇒ "改完看不到"**先问地址栏**。

## 部署（服务器 `~/radio`）
`build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）；**`git pull` 不影响运行中的容器** ⇒ 一次性脚本用 `docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。
加列/索引见 skill `sequelize-schema-rollout`：备份 → build → `db-repair.js` → up → 回填 → `queue/sweep`。radio-nginx 会莫名自退（Exited 0）⇒ 80 全拒时先看它。

## 本机坑
⚠️⚠️ **给陛下的命令**：本机 PowerShell（`C:\` 路径、无 `&&`、无 `tail`）与服务器 bash 必须**两个独立代码块**；**不给需要交互输入的命令**；**必须给判据**。
同一文件多处改动**串行 Edit**（并发静默吞前一个）。深色卡尾部提示被 flex-shrink 压扁 ⇒ `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。
vite 构建到"已存在"目录会被 safe-delete 垫片拦 ⇒ 构建到新目录。`admin-web/package.json` 有 `type:module` ⇒ 临时脚本用 `.cjs`。
不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；复用服务会跨会话掉线（截图前探活），`_shot.db` schema 变过要先 `rm`。
jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
⚠️⚠️ **push 本机做不了**（GCM 取不到凭据）⇒ commit 我负责、**push 陛下自己敲**（判据 `git status -sb` 无 `ahead N`）；**部署云函数本机也做不了**（沙箱拦 `reg.exe`），CLI `D:\dev\wx-devtools\cli.bat`。
PowerShell `Add-Type` 被拦 ⇒ 图像处理走 Python（`~/.workbuddy/binaries/python/versions/3.13.12/python.exe`，PIL 装这里；venv 路径不稳）。

## 后端约定
容器 UTC、MySQL 北京时间；按天/周**禁裸 `dayjs()`**，统一 `src/utils/bjTime.js`。路由顺序：字面量段在参数路由之前。
`toast.push({icon:X})` 图标必须已 import。三维状态保持数字；数字↔常量名只在 `songStatusService`。
新开关不进 `seed.js`（switch.test 断言恰好 4 条）⇒ 走 `switchService.KNOWN_SWITCHES`（缺行视为 on）。
`/admin/submit/list` 排序＝先提交先审（`create_time ASC, id ASC`）。⚠️ 老服务器 ↔ 云库会分叉。

## 启动动画素材（v4 零件，等点头）
站徽底稿 1410×1410，圆心＝图心 (704.5,704.5)；环字中文 5 字顺时针走顶、英文 18 字母逆时针走底，两行西起东收。
零件在 `preview/launch-v4/assets/`（80 PNG + parts/arcs/sprite）。切图统一 **`alpha > 0`**（>100 会丢抗锯齿边），校验要按清单 `(x,y)` 平移回绝对坐标。
✅ 线上 `miniprogram/components/launch-mask/` 仍是 v1 一个字没动，等陛下点头。
