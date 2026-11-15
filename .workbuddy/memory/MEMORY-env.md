# 菁悠广播站 · 环境 / 部署 / 后端约定

> 主册 `MEMORY.md`（四个端 + 铁律）· 业务分册 `MEMORY-partner-hub.md` / `MEMORY-sports-meet.md` / `MEMORY-cloud.md` /
> `MEMORY-club-key.md` / `PROJECT-NOTES.md` / `cloud/docs/final-cutover.md`。

## 业务分册速记（细节读分册）

- **伙伴端**：三身份 `member/manager/super`；底部角标唯一数据源 `TODO`（一件事只归一处、归零即隐、超 99 显 99+）；
  伙伴＝学生身份的第二种角色（`username` 就是学号）⇒ `partner_profile(user_id)` 挂 user，一人一套密码，超管走 admin；
  **互评是匿名聚合**，后台永不做"谁评谁"明细；分段胶囊 `flex:1` 填满轨道；对齐基准 `.view` 22 / 卡内 16 / 纵向 12；
  审计 `node _opfit/{audit,overflow,vars}.cjs <目录>` 必跑；截图 `_shots.sh`；屏幕清单在 `index.html` 的 `GROUPS`（`review` 屏已空）。
- **运动会**：`preview/sports-meet-v5`，四端 29 屏 + 大屏 5 版面，浅色无例外、线稿底必须透、`.wl-pnl gap:0`。
- **社团密钥**：整条线**不要求学生登录**，唯一凭证是票据；试错闸按 `ctx.source` 限速且必须落库；
  票据失效报 **40102**（40101 会清学生登录态）；作废必须清 `key_hash`；头像存 720×720 JPEG 0.86。
- **云开发**：⚠️ 新增集合必须配自愈（查没建过的集合是**抛错** `-502005`，不是空数组 ⇒ `lib/db.js#ensureCollections` + `readOr`）；
  小程序 `callFunction` 的 data 只有 **≈1MB** ⇒ 上传第一步客户端压；**名册逻辑三份副本**（`src/` + `cloud/…/services/roster.js` +
  `miniprogram/cloudfunctions/api/index.js`）；源 `cloud/cloudfunctions/api/`，运行目录是 `sync.js` 产物别手改；Windows CLI 传子目录必坏 ⇒ 打单文件。
- **启动动画素材（v4，等点头）**：站徽底稿 1410×1410，圆心＝图心 (704.5,704.5)；环字中文 5 字顺时针走顶、英文 18 字母逆时针走底。
  零件 `preview/launch-v4/assets/`（80 PNG + parts/arcs/sprite）；切图统一 **`alpha > 0`**（>100 丢抗锯齿边），
  校验按清单 `(x,y)` 平移回绝对坐标。线上 `components/launch-mask/` 仍是 v1。

## 部署（服务器 `~/radio`）

`build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）；**`git pull` 不影响运行中的容器** ⇒ 一次性脚本用
`docker cp cloud/. radio-backend:/app/cloud`（`-u root`，结尾 `/.`）。加列/索引见 skill `sequelize-schema-rollout`：
备份 → build → `db-repair.js` → up → 回填 → `queue/sweep`。radio-nginx 会莫名自退（Exited 0）⇒ 80 全拒时先看它。

## 后端约定

容器 UTC、MySQL 北京时间；按天/周**禁裸 `dayjs()`**，统一 `src/utils/bjTime.js`（AGENTS.md 写作 `services/bjTime.js`）。
路由顺序：字面量段在参数路由之前。`toast.push({icon:X})` 图标必须已 import。三维状态保持数字；数字↔常量名只在 `songStatusService`。
新开关不进 `seed.js`（switch.test 断言恰好 4 条）⇒ 走 `switchService.KNOWN_SWITCHES`（缺行视为 on）。
`/admin/submit/list` 排序＝先提交先审（`create_time ASC, id ASC`）。⚠️ 老服务器 ↔ 云库会分叉。
⚠️ **新增路由后硬编码计数会红**：`cloud/scripts/` 的 test-admin-routes（REGISTRY 42 / user 47）/ test-admin-core / selfcheck。
隐私口径文案不对外；源码/文档/提交信息**不写明文凭据**；默认密码留空随机 + 首次日志打印一次；写死 bcrypt hash ＝ 写死密码。
`JWT_SECRET` 线上公开值已修（`src/config/index.js` 有护栏）；`${X:-兜底}` 把空串当未设置 ⇒ 写空会静默回落。MySQL `root123` 确认不改。

## 本机坑

- ⚠️⚠️ **给陛下的命令**：本机 PowerShell（`C:\` 路径、无 `&&`、无 `tail`）与服务器 bash 必须**两个独立代码块**；
  **不给要交互输入的命令**；**必须给判据**。
- 同一文件多处改动**串行 Edit**（并发静默吞前一个）。vite 构建到"已存在"目录会被 safe-delete 垫片拦 ⇒ 构建到新目录。
  `admin-web/package.json` 有 `type:module` ⇒ 临时脚本用 `.cjs`。
- ⚠️ **仓库里 LF/CRLF 混着**（`pages-partner/club-notice/*`、`leave.js`、`submit.js` 是 CRLF）⇒ 批量插桩先探
  `s.indexOf('\r\n')` 再定分隔符，否则 `\n` 锚点**静默匹配失败**（throw 前不写盘，别慌）。
- 不开 Docker 整链路：`DB_STORAGE=./data/_shot.db` + `db:init` + `seed` + `node src/app.js`；schema 变过先 `rm`。
- jest 基线：56 条里 15 条失败全是已删 member 模块，别当新回归。
- ⚠️⚠️ **push 本机做不了**（GCM 取不到凭据）⇒ commit 我负责、**push 陛下自己敲**（判据 `git status -sb` 无 `ahead N`）；
  **部署云函数本机也做不了**（沙箱拦 `reg.exe`），CLI `D:\dev\wx-devtools\cli.bat`。
- PowerShell `Add-Type` 被拦 ⇒ 图像处理走 Python（`~/.workbuddy/binaries/python/versions/3.13.12/python.exe`，PIL 装这里）。
- 截图：`chrome.exe --headless=new --force-device-scale-factor=2 --window-size=W,H --user-data-dir=<每次独立>
  --virtual-time-budget=N --screenshot=out.png <file:///...>`。⚠️ `--screenshot` 只吃 **Windows 绝对路径**（`cygpath -m` 转）；
  无头下 CSS transition **不随 virtual-time 推进**，截图停在过渡起始帧 ⇒ 要对位次就 `--dump-dom` 读内联 style 或注入 `setTimeout(click)` 预置状态。
- 后台起 dev server 必须 `run_in_background`，否则 shell 退出即带走（ERR_CONNECTION_REFUSED）。
