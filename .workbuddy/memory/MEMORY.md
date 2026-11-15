# 菁悠广播站 · 项目长期备忘（主册）

> 分册按需读：**`MEMORY-env.md`**（部署/后端约定/本机坑/业务速记）· `MEMORY-partner-hub.md`（伙伴端 88 屏）·
> `MEMORY-sports-meet.md`（运动会）· `MEMORY-cloud.md`（云开发）· `MEMORY-club-key.md`（社团密钥）·
> `PROJECT-NOTES.md`（点歌/学生账号/登录页系列）· `MEMORY-archive-2026-10-14.md` · `cloud/docs/final-cutover.md`。

## 四个端，别搞混（2026-10-22 当面纠正）

1. 学生端小程序 `miniprogram/pages/*` —— 保留。
2. 小程序管理端 `pages-admin/` —— **退役**（伙伴端接位、改学号登录）。连带摘掉：app.json subpackages、app.js 的
   `adminToken/adminInfo/adminLogin/adminLogout/isAdminLoggedIn`、`utils/request.js#adminRequest`、`login.js:142`、
   `login.wxml:87-91`「管理员登录」。**云函数 `/admin/login` 不能删**（admin-web 在用）。
3. 伙伴端（原型 88 屏）—— 取代第 2 条。**2 和 4 不是一个东西**。
4. 管理端 web `admin-web/`（Vue3，14 页）—— 保留，只管电脑端；`/permissions`（`meta.superAdmin`）2026-11-02 补上。
- 登录要合并：人统一到 `user`（学号/工号都当 username）+ `admin.user_id` 绑定，老师 `user.kind=teacher`。

## 铁律 · 小程序（每条都踩过）

- ⚠️⚠️ **role 三档（0 超管 / 1 社干 / 2 站员）必须写满三档**，少一档＝看到别角色入口（2026-10-31 站员进稿件页冒出「审核」）。
  抄 `desk.js#roleKeyOf` / `me.js` / `schedule/index.js`；改完 `grep -rn "=== 0 ?"` 扫一遍。
- ⚠️⚠️ **导航栏右上＝微信胶囊（··· ◎），宽 87px、离边 7px，永不放可点元素或文字**（2026-11-09「复位」被退回）。
  腾位子靠标题 `position:absolute` 按**屏幕中线**居中（不按剩余空间），辅助操作挪进内容区。
- ⚠️⚠️ **WXML 模板只取值、不取属性**：`{{(a?b:c).length}}` 报 `Bad attr 'wx:if' ... unexpected token '.'`（2026-11-14 真机退回）。
  连带不支持 `?.` `??` 箭头函数 模板串 `.map()/.filter()` `new`；要算的在 JS 里摊好再传。探针 `_opfit/chk-recruit.cjs` [9]。
- ⚠️⚠️ **`wx.showToast` 的 title 在 `icon:'none'` 下最多两行**（2026-11-16 截图退回；19 字放得下、40 字必废）
  ⇒ 长文案一律走 `miniprogram/utils/tip.js#tip()`（按 20 字分流 `showModal`），别手写 showToast。
- ⚠️⚠️ **iOS 解析不了 `new Date('2026-11-16 00:39:00')`** ⇒ NaN ⇒ 排序静默退化。统一 `tsOf()`：
  `String(v).replace(/-/g,'/').replace('T',' ').replace(/\.\d+.*$/,'')`。
- ⚠️⚠️ **给 `<button>` 写样式一律 `button.xxx`**：`app.wxss` 的 `button.btn`(0,1,1) 会静默压掉 `.btn`(0,1,0) 的 `display:flex`。
- ⚠️⚠️ **input 的 `maxlength` 只是存储上限，不当业务字数限制**（「午间」= wujian，拼音第 6 位就截断）；业务限制写在校验里；
  input 用 `model:value` 双向绑定，别手写 `value`+`bindinput`+`setData`（跟输入法 composition 抢）。
- ⚠️ **靠 flex 居中的小件一律用 `<view>`**（text 是行内元件）；别靠 `line-height`=`height`；宽度随内容的按位数给档。
  探针 `_opfit/_badge_probe.html`。
- ⚠️⚠️ **圆形图片只靠外层圆盘削角**（`overflow:hidden`+`border-radius:50%`），别在 `<image>` 上写 radius 配死宽高 ——
  竖图必切上下（2026-11-09 徽标只剩半截）；宽高按源图比例缩（`bindload` 取宽高）。
- ⚠️ **加载骨架（23 屏已接）**：`sk` 初值 `true`，内容层 `wx:if="{{!sk || skOut}}"`；光只在块内走（`.sk::after`+`overflow:hidden`）；
  卡内整块灰、只有页面级框架留真字。**延迟档只有 i0–i7**：`i{{index>N?7:index+K}}` 要 **N+K ≤ 7**，越界算 i8＝无该类
  ⇒ 落到无延迟的 `.enter .in` 先冒出来。`_skcheck.cjs` 改完必跑。

## 铁律 · 构建 / CI

- **只做加法**：`src/`+`admin-web/`+Docker 一行不删，保留 `requestMode:'direct'|'cloud'`。**绝不用 `git checkout --`**。
- ⚠️⚠️ **本地绿 ≠ CI 绿**，两个坑：①`.gitignore` 的 `_*` 吃掉下划线开头的正式源码（`handlers/partner/_kit.js`、
  `_published.js` 从没进仓库 ⇒ #16/#17/#18 三连红、`publish` 从未跑过）；②**文件根本没 `git add`**（2026-11-14
  `utils/skeleton.js` 写好没入库 ⇒ CI #53 红、本机全绿）。⇒ 改 `.gitignore` 或新增文件后先 `node _opfit/chk-tracked-requires.cjs`
  ⇒ 必须 `ALL OK`；再 `git worktree add <干净树> <sha>` + `npm ci`（根+admin-web）跑 `regression.js --source` /
  `verify.js --scope mini` 才 push。
- ⚠️ **测试不许依赖"今天是星期几"**：可排窗口「周一 0 点~周六 24 点、周日只读」，凡 `PUT /partner/availability` 的用例周日必崩
  （2026-11-01 整段 `availability` undefined）。写法：文件顶部 `Date.now = () => FROZEN_NOW`，见 `test-partner-duty.js`。

## 铁律 · 设计 / 交付

- UI/视觉 **先出带版本号的静态预览，点头前不写业务代码**；版本只增不删；被否先问清形态，别偷偷捡回。
  ⚠️ 复制目录做新版本后**第一件事改页面上给人看的版本号**（title+页内文案），判据 `grep -o "v<N-1>" 新目录/*.html` = 0。
- ⚠️⚠️ **被否掉的稿子＝不存在**，重做不许参考，连备份也不许翻（2026-10-15）。依据只有方案文档 + 项目 token 源。
- ⚠️⚠️ **不许通用范式**（"换给别的 App 也成立"＝没做）→ 从业务隐喻长出来
  （已用：调频刻度、录音电平、收证钢印、骑缝孔、唱针、校舍、秩序册／检录牌／跑道分道线、机架通道号）。
- ⚠️⚠️ **不要深色——任何形式**：❌深色药丸/卡/面板/横幅/浮层；✅白卡+深色字+羊皮纸底；选中态 `--accent` 字 / `--accent-tint` 底。
  判据 `grep -c "var(--tile)" 页面` = 0（既有 `.tile`/`.dark-strip` 沿用合规，别自造第三种）。
  最易漏：站徽白底、`rgba(255,255,255,x)` 文字、SVG 硬编码刻度色、文案自称"深色卡"。
- **手机里不要装饰性描边框**（留＝有状态含义：已选/focus/`.slot.mine`），演示标注加在手机外。
- **圆角**：单行 9999px；内容卡 18px（Codex 层）／28px（旧口径）；卡上 9999 会变橄榄球。
- 站徽「菁悠」双色 浅 `#2497D5` / 深 `#093592`（仪器感元件用这组，别用 `#0066CC`）；`--live` 只给 ON AIR。
- **不锈钢禁拉丝**（点名两次）；抛光＝冷中性灰底 + 宽而柔斜向扫光。
- 学生登录页**不再有微信登录**（2026-10-02 拍板），不做相关入口/接口。
- ⚠️⚠️ **「现有 X」唯一事实源 = 真机截图 + `miniprogram/` 源码**（`preview/*` 是二手还原）。判据：这版落过业务代码吗。

## 铁律 · 发布

- ⚠️⚠️⚠️ **发布 = 覆盖同一个应用**：deploy **任何目录**都会覆盖 `jingyou-partner-hub` 链接（`domainPrefix` 无效）。
  **侧边方案/试验稿只本地 present_files，禁止 deploy**。线上目录 `preview/partner-hub-gounucai-v5/`，新版本先 cp 回 v5 再发；
  工作副本不是 v5（约 v150 起每版独立目录，2026-11-07 = v169·88 屏）。
- ✅✅ **只看一条：`git push` master 自动发布**（`cloud-release.yml`：verify → 只发变更那端）。**别再手动上传静态托管/部署云函数**。
- ⚠️⚠️ **改完「看不到」先量线上产物**（2026-11-16 又一轮）：①`GET /release.json` 的 `revision` 是否 = 目标 commit 全长（最硬）；
  ②目标 **chunk** 含新文案、不含旧文案 —— admin-web 是代码分割，主 bundle `index-<hash>.js` 只有路由表（全区仅 713 CJK 字），
  **只搜主 bundle 一律误报 ❌**。`index.html` 是 `no-store`、assets 带 hash ⇒ 缓存猜疑基本不成立，剩下是「push 完立刻看＝旧版」的时间差。
  探测 `scripts/_probe-web-bundle.cjs`（下划线开头，不进仓库）。
- ⚠️ 首次打开弹「风险提醒」中间页**不是部署坏了**；探测必须带浏览器同款请求头 + Node `https`（curl 会得反向结论），
  细则 `cloud/docs/final-cutover.md` §②-b-1。
- ⚠️⚠️ ⑧ 卡点是开关：`requestMode` 已 `'cloud'`，**只改代码不重新上传＝没生效，必须用微信客户端验**；学生走小程序 / 老师走 admin-web 两条独立线。
- ⚠️ `app.js:65-69` 有 `debug_requestMode` localStorage 覆盖；`jyradio.online` **未备案**（证书≠备案）。
  管理后台线上＝静态托管（**不是**服务器 Docker）：`admin-web-jy-radio-d1gdwmptl816ee6a9.webapps.tcloudbase.com`（少 `-1491709115` 返 418），
  API 网关 `…-1491709115.ap-shanghai.app.tcloudbase.com`。手搓才用 `_hosting`（裸 `vite build` 出 direct 包必废，
  判据 `grep -oh jy-radio- _hosting/assets/*.js` 要命中）。

## 动 UI / 编内容之前

先读 `PROJECT-NOTES.md`「先读这三处源」。底线：**别自起私有配色**、**别编业务事实**（站里没有 FM 频率）。
token 源：`miniprogram/app.wxss` → `admin-web/src/styles/theme.css`。`--accent #0066CC` 唯一强调色、无装饰渐变、无彩色投影。
尺寸换算：设计稿按 390pt 出图，**1px(设计) ≈ 1.923rpx**；正文 15px → 28rpx。
**admin-web 单页布局口径**（2026-11-16 招新页落地定稿）：flex 纵向 `gap:14px` + `height:100%` + 名单卡 `flex:1`，
页面必须撑满视口不留死白；短数据页面用「批次带（一条羊皮纸 + 竖线分隔的 KPI）」代替多张卡重复讲同一件事；
右侧 332px 栏放「流程五步 + 上下文」把横向空白变成"下一步做什么"。
`el-table` 的 `height` **只认像素**⇒ `ResizeObserver` 量容器真高传入；`table-layout:fixed` 下**所有列必须显式宽度**
（留一列 `auto` 会把全部余宽灌给它）。
