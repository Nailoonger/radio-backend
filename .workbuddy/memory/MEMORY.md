# 菁悠广播站 · 项目长期备忘（精简版）

> **细则按需读，别都塞这里**：
> `MEMORY-sports-meet.md`（运动会四端 UI 全口径 + 大屏 5 版面 + 四个坑）·
> `MEMORY-partner-hub.md`（伙伴端手机原型口径：模块/角标/Codex 基准/审计脚本）·
> `MEMORY-archive-2026-10-14.md`（更早的完整版）· `PROJECT-NOTES.md`（云开发细则、点歌体系、管理端小程序、登录页系列）·
> `docs/` · `cloud/docs/final-cutover.md` · 各 skill。

## ⚠️⚠️ 四个端，别搞混（2026-10-22 被当面纠正过）
1. 学生端小程序 `miniprogram/pages/*` 14 页 —— 保留。
2. **小程序管理端 `pages-admin/`（分包 5 页：login/todo/review/review-detail/message，走 admin 表账号）—— 决定退役**，
   由伙伴端接位、改**学号登录**。
3. 伙伴端（66 屏原型）—— 新端，取代第 2 条。
4. **管理端 web `admin-web/`（Vue3，13 页）—— 保留，只管电脑端**（导入/导出/开关/设置/看板）。
⚠️ 曾把第 2 条和第 4 条当成一个东西、以为要下线 admin-web → 被纠正「不是一个东西」。
⚠️ 退役连带：app.json subpackages · app.js adminToken/adminInfo/adminLogin/adminLogout/isAdminLoggedIn · `utils/request.js#adminRequest` ·
`pages/login/login.js:142` · `login.wxml:87-91`「管理员登录」。**云函数 `/admin/login` 不能删**（admin-web 还在用）。
⚠️ 登录要合并：人统一到 `user`（学号/工号都当 username）+ `admin.user_id` 绑定，老师加 `user.kind=teacher`。


## 铁律
- **只做加法**：`src/`+`admin-web/`+Docker 一行不删，保留 `requestMode:'direct'|'cloud'`。**绝不用 `git checkout --`**。
- ⚠️⚠️ **本地绿 ≠ CI 绿**：`.gitignore` 有条 `_*`，会吃掉下划线开头的**正式源码**
  （`handlers/partner/_kit.js`、`_published.js` 就这样从没进过仓库 ⇒ CI 里每个 partner handler
  `require('./_kit')` 直接崩 ⇒ #16/#17/#18 三连红、`publish` 从未执行过一次）。
  **碰了 `.gitignore`、或新增了文件，必须用 `git worktree add <干净树> <sha>` + `npm ci`（根 + admin-web）
  跑一遍 `cloud/scripts/regression.js --source` 再 push**。判据：干净树 `git ls-files` 能列出
  所有被 require 的文件；`sync.js` 打包模块数（61→70）就是"CI 跑的是不是这份代码"的硬指标。
- ⚠️⚠️ **给 `<button>` 写样式一律用 `button.xxx`（元素+类），不能只写 `.xxx`**：
  `app.wxss` 有 `button.btn{display:block;width:auto}` = 特异性 (0,1,1)，会**静默压掉**单类 `.btn`(0,1,0) 的 `display:flex`
  ⇒ 按钮退化成「块级 + line-height」单行行盒，**文字贴上沿、底下空一大截，不报错只是"看着有点歪"**
  （2026-10-29 slots 页两个蓝胶囊文字距顶 2px/距底 51px 就是这么来的；index/planning 本来写对所以没事）。
- ⚠️⚠️ **input 的 `maxlength` 只能是"存储上限"，绝不能当业务字数限制用**：
  中文拼音字母数远大于汉字数，「午间」= wujian = 6 个字母 —— maxlength=6 会**在第 6 个字母截断，汉字永远上不了屏**
  （2026-10-29 时段名称"打不进去"连踩两次的真凶）。业务限制写在校验里。
  同一坑的连带解：**input 用 `model:value` 双向绑定，别手写 `value`+`bindinput`+`setData`**（会跟输入法 composition 抢）。
- UI/视觉**先出带版本号的静态预览，点头前不写业务代码**；版本只增不删；被否先问清形态，别偷偷捡回。
  ⚠️⚠️ **复制目录做新版本后第一件事：改"页面上给人看的版本号"**（title + 页内文案），否则陛下判定"没更新"。
  判据 `grep -o "v<N-1>" 新目录/*.html` = 0（⚠️ SVG path 里的 `v14` 画线指令会误报，要人工看一眼）。
- ⚠️⚠️ **被否掉的稿子＝不存在**。重做时**不许参考已删稿，连备份也不许翻出来看**（2026-10-15 被当面退回：「删除就算了你还备份还拿出来看，如果能用的话我为什么叫你删除」）。
  新版本的依据只能是：**方案文档本身 + 项目 token 源**。被否的形态（如运动会「看台横幅拼贴风」）当作从没出现过。
- ⚠️⚠️ **不许通用范式**（"换给别的 App 也成立"＝没做）→ 从业务隐喻长出来（已用：调频刻度、录音电平、收证钢印、骑缝孔、唱针、校园校舍、秩序册／检录牌／跑道分道线）。
- ⚠️⚠️ **不要深色——任何形式**（点名三次）❌深色药丸/卡/面板/横幅/浮层。✅白卡 + 深色字 + 羊皮纸底；选中态 `--accent-tint` 底/`--accent` 字；主按钮 `--accent`。
  判据 `grep -c "var(--tile)" 页面` = 0（**既有设计系统的深色件不在此列**：小程序 `.tile`、后台 `theme.css` 里 `v8` 的 `.tile` 与 **`.dark-strip`** —— 沿用合规，别自造第三种深色件）。改浅色最易漏：站徽白底、`rgba(255,255,255,x)` 文字、SVG 硬编码刻度色、**文案自称"深色卡"**。
- **手机里不要装饰性描边框**；留=有状态含义（已选/focus/`.slot.mine`），演示标注一律加在手机外。
- **圆角胶囊**：单行元素 9999px；内容卡片 18px（Codex 层）／28px（旧口径）；卡片上 9999px 会变橄榄球（实测）。
- ⚠️⚠️⚠️ **发布 = 覆盖同一个应用**：本 sandbox 里 deploy **任何目录**都会覆盖 `jingyou-partner-hub` 链接（`domainPrefix` 无效）。**侧边方案/试验稿只本地 present_files，禁止 deploy**（2026-10-18 差点把线上 v42 换成运动会预览）。
- ⚠️⚠️ **线上站点目录 = `preview/partner-hub-gounucai-v5/`**（分享链接绑死这个目录）⇒ 新版本成果**先 cp 回 v5 再发布**，否则会新建 app 给新链接。工作副本已到 `v76`。
- 学生登录页**不再有微信登录**（2026-10-02 拍板），以后不做相关入口/接口。
- 站徽「菁悠」双色 浅 `#2497D5` / 深 `#093592`（仪器感元件用这组，别用 `#0066CC`）；`--live` 只给 ON AIR。
- **不锈钢禁拉丝**（点名两次）；抛光＝冷中性灰底 + 宽而柔斜向扫光，反光带窄硬＝褶皱。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**（`preview/*` 是二手还原，标"原样"的也有错）。判据：这版落过业务代码吗。
- 隐私口径文案不对外；源码/文档/提交信息**不写明文凭据**；默认密码不设默认值（留空随机 + 首次日志打印一次）；写死 bcrypt hash＝写死密码。
- `JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）；`${X:-兜底}` 把空串当未设置 ⇒ 写空会静默回落。MySQL `root123` 确认不改。

## ⚠️ 动 UI / 编内容之前
先读 `PROJECT-NOTES.md`「先读这三处源」（设计 token / 真实内容 / 结构事实）。底线：**别自起私有配色**、**别编业务事实**（站里没有 FM 频率）。
token 源：`miniprogram/app.wxss` → `admin-web/src/styles/theme.css`。`--accent #0066CC` 唯一强调色、无装饰渐变、无彩色投影。

## 伙伴端（手机原型，工作副本 v76）
细则 → `MEMORY-partner-hub.md`；逐版记录 → 当日日志；**后台对齐方案 → `preview/admin-sync-v1`（缺口）+ `v2`（更正与补充）**。
速记：**66 屏**（站员 12 / 社干 25 / 超管 29），三身份 `member/manager/super`；底部角标唯一数据源 `TODO`（同一件事只归一处、归零即隐、超 99 显示 99+）；
⚠️ **伙伴＝学生身份的第二种角色**（`user.username` 就是学号），不是第三种人 ⇒ 账号要 `partner_profile(user_id)` 挂 user，一人一套密码；超管走 admin。
⚠️ **互评是匿名聚合**（「只看得到内容，看不到人」）⇒ 后台永不做"谁评谁"的明细。
不深色；分段胶囊 `flex:1` 填满轨道；对齐基准 `.view` 22px / 卡内 16px / 纵向 12px；
审计 `node _opfit/{audit,overflow,vars}.cjs <版本目录>` 必跑；截图脚本 `_shots.sh`（`cygpath -m` 转路径，`--user-data-dir` 每次独立）。
屏幕清单在 `index.html` 的 `GROUPS`（⚠️ 里面残留 `review` 屏，v73 已删页面、渲染函数不存在，点开空白）。

## 运动会模块 UI
全口径已移到 **`MEMORY-sports-meet.md`**（v5 现行：四端 29 屏、大屏 5 版面、浅色无例外、线稿底必须透、`.wl-pnl gap:0`、四个坑）。目录 `preview/sports-meet-v5`。

## 云开发（`cloud/` 阶段 0–9，回归 3115 项 0 失败）
源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。⚠️ Windows CLI 传子目录必坏 ⇒ 打**单文件**，`handlers/index.js` **静态注册表**。
部署 `node cloud/scripts/deploy-cloud.js` → 手动 cli.bat → 等 1~2 分钟。
口径：业务查询用数字 `id`；4 张表业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段驼峰；`insertOne` 后改这行用返回的 `_id`。
⚠️⚠️ 切云弄坏上传类接口（信封 JSON ⇒ `FormData` 变 `{}`，40001）：契约 `{filename,fileBase64}`，凡 FormData/Blob 切云后必须单验。
⚠️⚠️ **HTTP 访问服务请求体上限 ≈100KB**（base64 再 +33%）⇒ 头像先压、名册导入大表会 413。小程序侧 `callFunction` ≈1MB 不受限。
⚠️⚠️ 学生初始密码＝`user`+学号（唯一出口 `studentAccountService.initPasswordFor()`；初始 cost 8、改密后 10）；管理端 DTO 字段是 `activated`。
⚠️⚠️⚠️ **名册逻辑有三份副本，改一处不算改完**：① `src/services/studentRosterService.js`（直连模式）
② **`cloud/cloudfunctions/api/services/roster.js`（云端副本＝线上真正跑的，函数同名行号不同）**
③ `miniprogram/cloudfunctions/api/index.js`（471K 单文件产物，`node cloud/scripts/sync.js` 打出，`--check` 校验）。
只改 `src/` ⇒ 切云后不生效；改完 cloud 侧不 `sync.js` ⇒ 部署的还是旧产物。**"改完没生效"先问改的哪一份、打包了没。**
⚠️ 云端唯一性**不是索引**，是 `unique_keys` 集合（`lib/db.js:170` `reserveUnique` → `_id="scope:key"`）；
运行时只用 `user_name` scope，`tables.js:33` 那个 `user_seat` 没人读（学号唯一即座位唯一）。

## 发布 & 真机收尾
✅✅ **发布只看一条：`git push` master 自动发布**（`.github/workflows/cloud-release.yml`）：verify → 只发变更那端。**别再手动上传静态托管/部署云函数**。预检 `node scripts/release/verify.js --scope mini`。
线上网页 `https://admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`（少 `-1491709115` 返 418）；API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。
管理后台线上＝静态托管（**不是**服务器 Docker）。手搓才用 `_hosting`（裸 `vite build` 出 direct 包必废，判据 `grep -oh jy-radio- _hosting/assets/*.js` 要命中）。
⚠️⚠️ 首次打开弹「风险提醒」中间页**不是部署坏了**；**探测必须带浏览器同款请求头 + Node `https`**（curl 会得反向结论），细则 `cloud/docs/final-cutover.md` §②-b-1。
⚠️⚠️ ⑧ 卡点是开关：`requestMode` 已 `'cloud'`，**只改代码不重新上传＝没生效，必须用微信客户端验**；学生走小程序（免备案）/老师走 admin-web 两条独立线。
⚠️ `miniprogram/app.js:65-69` 有 `debug_requestMode` localStorage 覆盖。`jyradio.online` **未备案**（证书 ≠ 备案）。✅ 服务器上那份 admin-web 已下线 ⇒ "改完看不到"**先问地址栏**。

## 部署（服务器 `~/radio`）
`build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）；**`git pull` 不影响运行中的容器** ⇒ 一次性脚本用 `docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。
加列/索引见 skill `sequelize-schema-rollout`：备份 → build → `db-repair.js` → up → 回填 → `queue/sweep`。radio-nginx 会莫名自退（Exited 0）⇒ 80 全拒时先看它。

## 本机坑
⚠️⚠️ **给陛下的命令**：本机 PowerShell（`C:\` 路径、无 `&&`、无 `tail`）与服务器 bash 必须**两个独立代码块**；**不给需要交互输入的命令**；**必须给判据**。
同一文件多处改动**串行 Edit**（并发静默吞前一个）。vite 构建到"已存在"目录会被 safe-delete 垫片拦 ⇒ 构建到新目录。`admin-web/package.json` 有 `type:module` ⇒ 临时脚本用 `.cjs`。
不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；`_shot.db` schema 变过要先 `rm`。
jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
⚠️⚠️ **push 本机做不了**（GCM 取不到凭据）⇒ commit 我负责、**push 陛下自己敲**（判据 `git status -sb` 无 `ahead N`）；**部署云函数本机也做不了**（沙箱拦 `reg.exe`），CLI `D:\dev\wx-devtools\cli.bat`。
PowerShell `Add-Type` 被拦 ⇒ 图像处理走 Python（`~/.workbuddy/binaries/python/versions/3.13.12/python.exe`，PIL 装这里）。

## 后端约定
容器 UTC、MySQL 北京时间；按天/周**禁裸 `dayjs()`**，统一走北京时间工具（AGENTS.md 写作 `services/bjTime.js`，实际 `src/utils/bjTime.js`）。路由顺序：字面量段在参数路由之前。
`toast.push({icon:X})` 图标必须已 import。三维状态保持数字；数字↔常量名只在 `songStatusService`。
新开关不进 `seed.js`（switch.test 断言恰好 4 条）⇒ 走 `switchService.KNOWN_SWITCHES`（缺行视为 on）。
`/admin/submit/list` 排序＝先提交先审（`create_time ASC, id ASC`）。⚠️ 老服务器 ↔ 云库会分叉。
⚠️ **新增 `/admin/**` 路由后 4 处硬编码计数会红**（`cloud/scripts/` 的 test-admin-core / test-admin-routes / selfcheck）——见 `PROJECT-NOTES.md`。

## 启动动画素材（v4 零件，等点头）
站徽底稿 1410×1410，圆心＝图心 (704.5,704.5)；环字中文 5 字顺时针走顶、英文 18 字母逆时针走底，两行西起东收。
零件在 `preview/launch-v4/assets/`（80 PNG + parts/arcs/sprite）。切图统一 **`alpha > 0`**（>100 会丢抗锯齿边），校验要按清单 `(x,y)` 平移回绝对坐标。
✅ 线上 `miniprogram/components/launch-mask/` 仍是 v1 一个字没动，等陛下点头。
