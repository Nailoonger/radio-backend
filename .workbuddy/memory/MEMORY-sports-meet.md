# 运动会模块 UI 存档（2026-10-16 · v5 现行口径）

> 从 `MEMORY.md` 压缩时整段移出。**口径仍然有效**，只是不再占主文件。
> 目录：`preview/sports-meet-v5`（v3/v4 目录保留不删）。

⚠️ v3「自造三张纸形式语言」作废、v4 是「结合现有的做」的第一版，**v5 在 v4 之上补同事 Codex 版的四条长处**。
v5 与 v4 的差异只有两处：① `assets/campus-line-art.png`（陛下 2026-10-11 给的儋州街景线稿）＋大屏增量 CSS ② `wall.html` 重写。**其余四页只改了 title/kicker 的版本号，一行业务没动**（`diff sports-meet-v4 sports-meet-v5` 只 8 个文件，其中 5 个只差版本号）。

四份事实源（值直接抄，不凭印象）：① `miniprogram/app.wxss` 设计系统 v2（rpx@375＝0.5px）② `miniprogram/pages/index/index.{wxml,wxss}` 首页真实结构＝落位依据 ③ `admin-web/src/styles/theme.css`＋`layouts/MainLayout.vue`＋`views/Dashboard.vue`＋`views/SubmitList.vue` ④ `preview/partner-hub-gounucai-v5/app.html` 第 461 行起的「Codex 视觉语言覆盖层」＝社干端最终生效视觉。

四端 **29 屏**：`index.html`（5 tab＋`#home/#student/#mobile/#admin/#wall`）＋ home 3（**首页落位**：运动会＝「正在直播」深色卡之后、「本周点歌排期」之前的**同级 `.section`**，会期结束整段 `wx:if` 摘除、其余四块一行不动）＋ student 10（375×812）＋ mobile 4（390×846 社干快录，主触区 44px）＋ admin 7（1440×900 `zoom:.62`）＋ wall **5 版面**（1920×1080 `zoom:.5`）。

⚠️⚠️ **接缝＝三端既定差异，必须尊重、不许统一**：后台选中＝**墨黑胶囊**（非蓝底）、`.main` **纯白** padding 20；社干端**零深色块**（`.hero` 也白底）、状态＝**小方角灰块 7px**、按钮 **13px 圆角**、dock 悬浮白胶囊＋accent 实心；学生端 `.tag` 胶囊＋`.segment` 白药丸。

⚠️⚠️ **大屏也必须是浅色**（2026-10-15 陛下点名：「校园大屏要浅色的啊做深色的干啥」）⇒ 「不给深色开任何例外」**四端全部成立，全站零深色件**。原「大屏是唯一允许深色的一屏」作废。

⚠️⚠️ **大屏必须可点按**（2026-10-15：「我要可交互的点按不是单纯图片」）⇒ `wall.html` 是数据驱动单块屏 + `.ctl` 控制台：**5 版面 × 3 时刻 × 各自子页**自由组合 + 「自动轮播」开关；深链 `?scene=N&clock=N&sub=N`。**全天赛程 `D.sched` 是唯一事实源**，①「正在进行」⑤「赛程状态」①「已确认 X 项」⑤「已结束 X 项」全由它 + 当前时刻推出（`state()/confirmed()`，窗口 30 分钟），不许手写第二份。

新造视觉件只有两个：`.leg`（检录牌 26px 方角 4px 印戳）· `.race-lane`（道次线 3px 状态色竖条）。其余全是现有类。**32 个色值全部对得上源码、零自造**（曾自造 `#A9793B` 名次第三色，已改 `--soft`）。v5 的 `diff v4..v5` 新增行里**色值 = 0 个新的**。

**大屏左上角徽标＝学校校徽**（陛下 2026-10-16 给的 `Desktop/校徽.png` ⇒ 原样搬成 `assets/school-badge.png`，md5 逐字节一致，未裁切/未调色/未描边；344×344 RGBA、图形占画布 98.8%、四角透明，56px 直接用）。⚠️ 只换大屏；小程序首页 `.brand-logo` 仍是 `station-badge.png`（菁悠站徽），**别一起换**。

## v5 大屏增量

**结构**：`.wl-body.stk`（column）＝ 焦点带 `.wl-band` + `.wl-cols`（原 `.wl-col` 原样装在里面）。**每屏一个绝对视觉焦点**放在内容之上，不参与等分。
- `.wl-hero .num` 136px 超大数字（赛况「N 场正在进行」/积分「领跑分」/校纪录「N 项本届刷新」/赛程「下一场时刻」）；`.wl-hero-rec .tm` 126px 破纪录超大字。`.wl-kpi` 右侧两三个 44px 关键数。标题栏补 `<div class="wl-id">`＋校名，`.wl-tab` 是版面名（`margin-left:auto`，用 `.wl-tab + .wl-clock{margin-left:26px}` 压掉 `.wl-clock` 自己的 auto）。
- **版面 4→5**：15 个班全量塞进半屏会小到看不清，**积分独立成一屏**。5 版＝赛况(1)/班级积分(3＝高一高二高三)/晋级与破纪录(3)/校纪录榜(1)/全天赛程(1)，共 9 页。
- **积分只有积分制，不分金/银/铜**（2026-10-17：「没有金银之分，只有积分制」）：`D.pts[年级] = [[班号, 积分], …]`，`board(g)` 只排序 + **并列不跳号**（同分同名次，下一个跳过；高一就是 1、1、3）。列优先 3 列 × 5 行：`.wl-grid > .wl-gcol ×3`（`.wl-cell{flex:1 1 auto}`）。
- **破纪录的班挂个小标注**（同日第二条：「有破纪录的班级你搞一个小标注就可以」）：`.bk` 小胶囊（15px，焦点带上 17px），**透明底 + `1px solid var(--amber-fg)` 描边 + 琥珀字**（同日第三条：「胶囊做成透明的啊，不然看不到背景了」⇒ 不许实心底）。名单由 `recClasses()` **从 `D.rec` 现推**（只算裁判长已确认的项），**不另立一份名单**。
  ⇒ 为此 `D.rec` 拆成 `[项目, 谁, **班级**, 成绩, 原纪录, 开赛时刻]`，**班级单独一列**。留意别处索引：`confirmed(r[5])`、`latest[3]` 才是成绩。
- **晋级分页**：`advPageList()` 一页 6 人（16 人＝3 页），**翻页重复组标题**（跟纸质秩序册一个做法）；`.wl-grp` 是组标题样式。
- **破纪录**：焦点带给「最新一项」超大字（`D.rec` 按开赛时刻升序，`recSet()` 取尾），右卡列**其余项**逐条带原纪录。⚠️ 原计划「2 项一页」**没做** —— 放得下就不翻，省下的位置给了「更正与撤销」块。
- **子页游标各自保存**：`SUBS=[1,3,3,1,1]` + `sub=[0,0,0,0,0]`；轮播 **15 秒一页**，当前屏子页翻完才进下一屏（全轮 9 页）；手动切屏回到该屏上次停的那一页。
- **校园线稿做底，而且必须透得出来**：`assets/campus-line-art.png`（2912×1344 白底线稿）挂 `.screen-wl::before`，`opacity:.16` + **`mix-blend-mode:multiply`**。
  ⚠️⚠️ **面板必须是半透明白 `--wl-panel: rgba(255,255,255,.66)`**（2026-10-17：「胶囊做成透明的啊，不然看不到背景了」）。我第一版给不透明白，线稿被整块盖住，**等于白做** —— 他说的「胶囊」就是那些圆角白卡。四处（`.wl-top/.wl-band/.wl-pnl/.wl-foot`）统一走 `var(--wl-panel,var(--canvas))`。`.screen-wl > *{z-index:1}` ⇒ 线稿永远在面板和字的下层。
- ⚠️⚠️ **`.wl-pnl` 的 `gap` 必须是 0**：`.wl-row` 自带 18px 上下内边距；再叠 `gap:13px` 会**乘上行数** —— 8 行的榜光 gap 就多吃 104px，把面板撑破（实测 `wl3/wl13 v+46`）。表头间距改 `.wl-pnl-h{margin-bottom:6px}` 单给。
- ⚠️⚠️ **`.wl-pnl.stretch`** 三件事一起做才稳：`justify-content:center` + `.wl-row{flex:1 1 auto}` + `max-height:170px`。少 `max-height` 只剩 1 行时拉成柱子；少 `flex:1` 4 行卡底部留白。配套 `.wl-pnl.stretch .wl-bottom{margin-top:0}`。`.wl-cell` 同理。

**判据** `assets/probe.js`：`?probe=detail` → `--dump-dom` 抓 `#probe-out`，**51 项全 `ALL_CLEAN`**。⚠️ 探针**必须带 `--window-size`**（home ≥1052、admin ≥945、wall ≥1012；默认 800 误报）。滚动容器（`.mp-body/.ph-body/.ad-body`）只查横向；不滚动版面（`.wl-*`）纵横都查。⚠️ detail 模式要 `:not(.mark)`。
逐屏截图 `bash _shots.sh` → `shots/` **34 张**；判据「大屏 9 张 md5 唯一数 = 9/9」。
⚠️ 大屏 `zoom:.5`，**看细节要放大**：用「临时 HTML + `transform:scale(1.8)` + 负 left/top」二次截图裁切。

**同事 Codex 版**（`preview/sports-meet-codex-v1`，只读）：长处＝每屏一个绝对焦点、积分 15 班全量并列、破纪录带原纪录、15 秒轮播＋子页游标 —— **v5 全补了**。短处（不跟）：8 个自造色、`backdrop-filter` 20 处 + `gradient` 6 处 + `box-shadow` 14 处蓝灰彩色投影 —— `theme.css:189` 明确 `backdrop-filter:none !important`、`:132/166 box-shadow:none !important`。**去玻璃／去投影／去渐变／1px 描边＝v8 现行方向。** 它的内容藏在 `<iframe data-srcdoc>` 的转义属性里，要抽 `data-srcdoc` 反转义再渲染。

⚠️⚠️ **本目录踩过的四个坑**：
1. **不许在全局声明 `function top(){}`** —— `window.top` 只读，整段 script SyntaxError、一行不跑，`node --check` **查不出来**。已改名 `topbar`。同类：`name/status/open/close/length/origin/parent/self/frames/event/history/location/screen/scroll/external/toolbar/menubar/navigator/crypto/customElements`。
2. **`_shots.sh` 里 bash 的 `pwd` 给 `/c/Users/...`，拼 `file:///c/...` 会 ERR** ⇒ 必须 `cygpath -m`。每张落地后 `[ -s 文件 ]` 校验。
3. **Chrome `--user-data-dir` 不能共用** —— 单例抢锁会拿到上一次页面（表现为「所有 admin 屏都报同一个假溢出」）。每次独立目录。
4. **传参别错位**：`probe(){ ... --window-size="$2,$3" ... }`，写成 `$3,$4` 会因 `$4` 空使参数非法 → Chrome 回落 800 → 假 `PAGE h+161`。
