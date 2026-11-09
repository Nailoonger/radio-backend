# 菁悠广播站 · 项目长期备忘

> 细则按需读：`MEMORY-partner-hub.md`（伙伴端原型口径）· `MEMORY-sports-meet.md`（运动会四端 + 大屏）·
> `MEMORY-archive-2026-10-14.md` · `PROJECT-NOTES.md`（云开发、点歌、管理端小程序、登录页系列）· `cloud/docs/final-cutover.md`。

## 四个端，别搞混（2026-10-22 被当面纠正过）
1. 学生端小程序 `miniprogram/pages/*` —— 保留。
2. 小程序管理端 `pages-admin/`（分包 5 页）—— **退役**，由伙伴端接位、改学号登录。
3. 伙伴端（原型 88 屏）—— 新端，取代第 2 条。
4. 管理端 web `admin-web/`（Vue3，14 页）—— **保留，只管电脑端**；`/permissions`（`meta.superAdmin`）2026-11-02 补上。
- 2 和 4 **不是一个东西**。2026-10-31 摘掉的 9 条 `/partner/*` 仍摘掉；后端接口是 `/partner/permissions` 那三个口子。
- 退役连带：app.json subpackages · app.js `adminToken/adminInfo/adminLogin/adminLogout/isAdminLoggedIn` ·
  `utils/request.js#adminRequest` · `pages/login/login.js:142` · `login.wxml:87-91`「管理员登录」。**云函数 `/admin/login` 不能删**（admin-web 在用）。
- 登录要合并：人统一到 `user`（学号/工号都当 username）+ `admin.user_id` 绑定，老师加 `user.kind=teacher`。

## 铁律
- ⚠️⚠️ **role 三档（0 超管 / 1 社干 / 2 站员）判定必须写满三档**，少一档 = 看到别的角色的入口
  （2026-10-31 站员进稿件页冒出「审核」格：`work.js`/`review.js` 只写 `role===0?'super':'manager'`）。
  抄 `desk.js#roleKeyOf` / `me.js` / `schedule/index.js`；改完 `grep -rn "=== 0 ?"` 扫一遍。
- ⚠️⚠️ **小程序导航栏右上＝微信胶囊（··· ◎），宽约 87px、离边 7px，永不放任何可点元素或文字**
  （2026-11-09 当面退回：把「复位」放那儿＝跟退出键打架）。腾位子的办法是标题 `position:absolute` 按**屏幕中线**居中，
  不按剩余空间居中；辅助操作挪进内容区（例：滑杆下面那一行右侧）。
- **只做加法**：`src/` + `admin-web/` + Docker 一行不删，保留 `requestMode:'direct'|'cloud'`。**绝不用 `git checkout --`**。
- ⚠️⚠️ **本地绿 ≠ CI 绿**：`.gitignore` 的 `_*` 会吃掉下划线开头的正式源码（`handlers/partner/_kit.js`、`_published.js`
  从没进过仓库 ⇒ CI 里 partner handler `require('./_kit')` 崩 ⇒ #16/#17/#18 三连红、`publish` 从未跑过）。
  碰了 `.gitignore` 或新增文件 ⇒ 必须 `git worktree add <干净树> <sha>` + `npm ci`（根 + admin-web）跑
  `regression.js --source` 再 push。判据：干净树 `git ls-files` 能列出所有被 require 的文件；`sync.js` 打包模块数是硬指标。
- ⚠️⚠️ **给 `<button>` 写样式一律用 `button.xxx`**：`app.wxss` 的 `button.btn{display:block;width:auto}` 特异性 (0,1,1)
  会静默压掉单类 `.btn`(0,1,0) 的 `display:flex` ⇒ 退化成块级行盒，文字贴上沿、底下空一截，不报错只是"看着有点歪"。
- ⚠️⚠️ **input 的 `maxlength` 只是存储上限，绝不当业务字数限制**：中文拼音字母远多于汉字（「午间」= wujian = 6 字母），
  maxlength=6 会在第 6 个字母截断 ⇒ 汉字永远上不了屏。业务限制写在校验里。
  连带：**input 用 `model:value` 双向绑定**，别手写 `value`+`bindinput`+`setData`（跟输入法 composition 抢）。
- ⚠️ **靠 flex 居中的小件（角标/胶囊/圆圈）一律用 `<view>`**（text 是行内元件，`display:flex` 不生效）；
  居中别靠 `line-height`=`height`（只摆正行盒）；宽度随内容的（1 位/2 位/99+）**按位数给档位**，别靠 padding。
  探针 `_opfit/_badge_probe.html`（偏差 ≤0.12px）。
- ⚠️⚠️ **圆形图片只靠外层圆盘削角**（`overflow:hidden` + `border-radius:50%`），**别在 `<image>` 上写 `border-radius` 再配死宽高** ——
  方图看不出问题，**竖图必被切上下**（2026-11-09 学生会徽标顶部只剩半截）。宽高按源图比例缩进圆盘（`bindload` 取宽高）。
- UI/视觉**先出带版本号的静态预览，点头前不写业务代码**；版本只增不删；被否先问清形态，别偷偷捡回。
  ⚠️⚠️ 复制目录做新版本后**第一件事改页面上给人看的版本号**（title + 页内文案），否则判"没更新"。
  判据 `grep -o "v<N-1>" 新目录/*.html` = 0（SVG path 的 `v14` 画线指令会误报，人工看一眼）。
- ⚠️⚠️ **被否掉的稿子＝不存在**，重做时不许参考，连备份也不许翻（2026-10-15 当面退回）。依据只能是方案文档 + 项目 token 源。
- ⚠️⚠️ **不许通用范式**（"换给别的 App 也成立"＝没做）→ 从业务隐喻长出来
  （已用：调频刻度、录音电平、收证钢印、骑缝孔、唱针、校园校舍、秩序册／检录牌／跑道分道线）。
- ⚠️⚠️ **不要深色——任何形式**（点名三次）❌深色药丸/卡/面板/横幅/浮层。✅白卡 + 深色字 + 羊皮纸底；
  选中态 `--accent-tint` 底/`--accent` 字；主按钮 `--accent`。判据 `grep -c "var(--tile)" 页面` = 0
  （既有系统的深色件不算：小程序 `.tile`、`theme.css` 的 `.tile` 与 `.dark-strip` —— 沿用合规，别自造第三种）。
  改浅色最易漏：站徽白底、`rgba(255,255,255,x)` 文字、SVG 硬编码刻度色、文案自称"深色卡"。
- **手机里不要装饰性描边框**（留 = 有状态含义：已选/focus/`.slot.mine`），演示标注加在手机外。
- **圆角**：单行元素 9999px；内容卡 18px（Codex 层）／28px（旧口径）；卡上 9999px 会变橄榄球。
- ⚠️⚠️⚠️ **发布 = 覆盖同一个应用**：deploy **任何目录**都会覆盖 `jingyou-partner-hub` 链接（`domainPrefix` 无效）。
  **侧边方案/试验稿只本地 present_files，禁止 deploy**。线上目录 = `preview/partner-hub-gounucai-v5/`，新版本**先 cp 回 v5 再发**。
  ⚠️ 工作副本不是 v5：约 v150 起每版独立目录 `partner-hub-gounucai-v<N>/`，动手前先找最新完整版（2026-11-07 = **v169**·88 屏）。
- 学生登录页**不再有微信登录**（2026-10-02 拍板），以后不做相关入口/接口。
- 站徽「菁悠」双色 浅 `#2497D5` / 深 `#093592`（仪器感元件用这组，别用 `#0066CC`）；`--live` 只给 ON AIR。
- **不锈钢禁拉丝**（点名两次）；抛光＝冷中性灰底 + 宽而柔斜向扫光，反光带窄硬＝褶皱。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**（`preview/*` 是二手还原，标"原样"的也有错）。判据：这版落过业务代码吗。
- 隐私口径文案不对外；源码/文档/提交信息**不写明文凭据**；默认密码不设默认值（留空随机 + 首次日志打印一次）；写死 bcrypt hash ＝ 写死密码。
- `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）；`${X:-兜底}` 把空串当未设置 ⇒ 写空会静默回落。MySQL `root123` 确认不改。
- ⚠️⚠️ **测试不许依赖"今天是星期几"**：可排窗口「周一 0 点~周六 24 点、周日只读」，凡 `PUT /partner/availability` 的用例周日跑必崩
  （2026-11-01 踩到：周六 266/0 全绿、周日整段 `availability` undefined）。写法：文件顶部 `Date.now = () => FROZEN_NOW`，见 `test-partner-duty.js`。

## 动 UI / 编内容之前
先读 `PROJECT-NOTES.md`「先读这三处源」。底线：**别自起私有配色**、**别编业务事实**（站里没有 FM 频率）。
token 源：`miniprogram/app.wxss` → `admin-web/src/styles/theme.css`。`--accent #0066CC` 唯一强调色、无装饰渐变、无彩色投影。
尺寸换算：设计稿按 390pt 出图，**1px(设计) ≈ 1.923rpx**；正文 15px → 28rpx。

## 伙伴端（手机原型）
细则 → `MEMORY-partner-hub.md`；后台对齐 → `preview/admin-sync-v1`（缺口）+ `v2`（更正）。
速记：三身份 `member/manager/super`；底部角标唯一数据源 `TODO`（一件事只归一处、归零即隐、超 99 显示 99+）。
⚠️ **伙伴＝学生身份的第二种角色**（`user.username` 就是学号），不是第三种人 ⇒ `partner_profile(user_id)` 挂 user，一人一套密码；超管走 admin。
⚠️ **互评是匿名聚合**（只看内容看不到人）⇒ 后台永不做"谁评谁"明细。
分段胶囊 `flex:1` 填满轨道；对齐基准 `.view` 22px / 卡内 16px / 纵向 12px；
审计 `node _opfit/{audit,overflow,vars}.cjs <版本目录>` 必跑；截图 `_shots.sh`（`cygpath -m` 转路径，`--user-data-dir` 每次独立）。
屏幕清单在 `index.html` 的 `GROUPS`（⚠️ 残留 `review` 屏，渲染函数已删，点开空白）。

## 运动会模块 UI
全口径在 **`MEMORY-sports-meet.md`**（v5：四端 29 屏、大屏 5 版面、浅色无例外、线稿底必须透、`.wl-pnl gap:0`、四个坑）。
目录 `preview/sports-meet-v5`。

## 社团密钥 / 社团提报（2026-11-07 落地）
细则 → **`MEMORY-club-key.md`**（状态机、票据、试错闸、并发控制、权限位）。
- ⚠️⚠️ **整条线不要求学生登录**，唯一凭证是票据；试错闸按 `ctx.source` 限速、必须落库。
- ⚠️ 票据失效报 **40102**（40101 会清学生登录态）；作废必须清 `key_hash`。
- 头像 `PUT /user/club-key/avatar`，存 **720×720 方图** JPEG 0.86。

## 云开发（`cloud/` 阶段 0–9）
细则 → **`MEMORY-cloud.md`**（集合自愈、三份名册副本、上传两道 base64 上限、部署流程）。
- ⚠️⚠️⚠️ **新增集合必须配自愈**：云开发查没建过的集合是**抛错** `-502005`，不是返回空数组 ⇒ `lib/db.js#ensureCollections` 先建 + 读操作套 `readOr`。
- ⚠️⚠️ **小程序 `callFunction` 的 data 只有 ≈1MB**（不是"不受限"）⇒ 上传类接口第一步是客户端压。
- ⚠️⚠️⚠️ **名册逻辑三份副本**（`src/` + `cloud/.../services/roster.js` + `miniprogram/cloudfunctions/api/index.js`），改一处不算改完。
- 源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`（后者是 `sync.js` 产物，别手改）；Windows CLI 传子目录必坏 ⇒ 打单文件。

## 发布 & 真机收尾
✅✅ **发布只看一条：`git push` master 自动发布**（`.github/workflows/cloud-release.yml`：verify → 只发变更那端）。**别再手动上传静态托管/部署云函数**。
预检 `node scripts/release/verify.js --scope mini`。线上网页 `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`（少 `-1491709115` 返 418）；
API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。管理后台线上＝静态托管（**不是**服务器 Docker）。
手搓才用 `_hosting`（裸 `vite build` 出 direct 包必废，判据 `grep -oh jy-radio- _hosting/assets/*.js` 要命中）。
- ⚠️⚠️ 首次打开弹「风险提醒」中间页**不是部署坏了**；探测必须带浏览器同款请求头 + Node `https`（curl 会得反向结论），细则 `cloud/docs/final-cutover.md` §②-b-1。
- ⚠️⚠️ ⑧ 卡点是开关：`requestMode` 已 `'cloud'`，**只改代码不重新上传＝没生效，必须用微信客户端验**；学生走小程序（免备案）/老师走 admin-web 两条独立线。
- ⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖。`jyradio.online` **未备案**（证书≠备案）。服务器那份 admin-web 已下线 ⇒ "改完看不到"先问地址栏。

## 部署（服务器 `~/radio`）
`build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）；**`git pull` 不影响运行中的容器** ⇒ 一次性脚本用
`docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。加列/索引见 skill `sequelize-schema-rollout`：
备份 → build → `db-repair.js` → up → 回填 → `queue/sweep`。radio-nginx 会莫名自退（Exited 0）⇒ 80 全拒时先看它。

## 本机坑
- ⚠️⚠️ **给陛下的命令**：本机 PowerShell（`C:\` 路径、无 `&&`、无 `tail`）与服务器 bash 必须**两个独立代码块**；
  **不给需要交互输入的命令**；**必须给判据**。
- 同一文件多处改动**串行 Edit**（并发静默吞前一个）。vite 构建到"已存在"目录会被 safe-delete 垫片拦 ⇒ 构建到新目录。
  `admin-web/package.json` 有 `type:module` ⇒ 临时脚本用 `.cjs`。
- 不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；schema 变过先 `rm`。
- jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
- ⚠️⚠️ **push 本机做不了**（GCM 取不到凭据）⇒ commit 我负责、**push 陛下自己敲**（判据 `git status -sb` 无 `ahead N`）；
  **部署云函数本机也做不了**（沙箱拦 `reg.exe`），CLI `D:\dev\wx-devtools\cli.bat`。
- PowerShell `Add-Type` 被拦 ⇒ 图像处理走 Python（`~/.workbuddy/binaries/python/versions/3.13.12/python.exe`，PIL 装这里）。
- 截图：`chrome.exe --headless=new --force-device-scale-factor=2 --window-size=W,H --user-data-dir=<每次独立> --virtual-time-budget=N --screenshot=out.png <file:///...>`。
  ⚠️ 无头下 CSS transition **不随 virtual-time 推进**，截图停在过渡起始帧；要对位次就 `--dump-dom` 读内联 style，别信截图。
  `file:///...index.html#pill` 这种 hash 可预置状态，省得点。

## 后端约定
容器 UTC、MySQL 北京时间；按天/周**禁裸 `dayjs()`**，统一走 `src/utils/bjTime.js`（AGENTS.md 写作 `services/bjTime.js`）。路由顺序：字面量段在参数路由之前。
`toast.push({icon:X})` 图标必须已 import。三维状态保持数字；数字↔常量名只在 `songStatusService`。
新开关不进 `seed.js`（switch.test 断言恰好 4 条）⇒ 走 `switchService.KNOWN_SWITCHES`（缺行视为 on）。
`/admin/submit/list` 排序＝先提交先审（`create_time ASC, id ASC`）。⚠️ 老服务器 ↔ 云库会分叉。
⚠️ **新增路由后硬编码计数会红**：`cloud/scripts/` 的 test-admin-routes（REGISTRY 42 / user 47）/ test-admin-core / selfcheck —— 见 `PROJECT-NOTES.md`。

## 启动动画素材（v4 零件，等点头）
站徽底稿 1410×1410，圆心＝图心 (704.5,704.5)；环字中文 5 字顺时针走顶、英文 18 字母逆时针走底，两行西起东收。
零件在 `preview/launch-v4/assets/`（80 PNG + parts/arcs/sprite）。切图统一 **`alpha > 0`**（>100 丢抗锯齿边），校验按清单 `(x,y)` 平移回绝对坐标。
✅ 线上 `miniprogram/components/launch-mask/` 仍是 v1 一个字没动，等点头。
