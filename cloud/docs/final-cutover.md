# 真机收尾清单（阶段 9 之后 · 一次性）

> 目标：把「服务器 Express + MySQL」整体切到「云开发 + 云数据库 + HTTP 访问服务」。
> 原则：**原链路一行不删、随时可切回**（admin-web 只改一个环境变量）。
> 现状：阶段 0–9 的代码 / 断言 / 文档全完成；本机回归 **3115 项 / 0 失败**。
> 相关：迁移三步的细节见 `cloud/migration/README.md`；通道选型见 `stage9-admin-web-plan.md`。

---

## 进度

| 步 | 状态 | 证据 / 产物 |
|---|---|---|
| ① 配 HTTP 访问服务 | ✅ **已完成** | 路由 `/api` 已生效；域名 `jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com` |
| ② 部署云函数 | ✅ **已完成** | `success: true`、`filesCount: 3`、`packSize 126.3 KB` |
| ③ 导出生产库 | ✅ **已完成** | 16 表 / **686 行** / warning 0 / error 0；`unique_keys` 556 条、`sequence` 16 条 |
| ④ 导入云数据库 | ✅ **已完成** | 控制台导入 17 个集合（`message` 本就空，跳过）；Upsert |
| ⑤ 导出云库做基线 | ✅ **已完成** | `cloud/migration/cloud-dump/`（17 个 `<集合名>.json`） |
| ⑥ 双向校验 | ✅ **已完成** | 表 16 / 失败 0；行 源 686 = 云 686；缺 0 / 孤 0 / 字段差 0 / 结构问题 0 |
| ⑦ admin-web 切 cloud | ✅ **已完成** | 8 个接口实测全绿 + 真实浏览器登录成功（2026-09-29）；`dist/` 已含云域名、无 direct 残留 |
| ⑧ 小程序切 cloud | ✅ **体验版已验证，待发正式版** | 陛下真机实测：**不再报错、可正常登录**，且**无需再开「不校验合法域名」**；另 13 个学生端只读接口云端全绿（见下文 ⑧） |

### ①② 的实测结论（2026-09-29 13:53）

```bash
curl "https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api/health"
# → HTTP 200
# {"code":0,"message":"ok","data":{"ok":true,"jwtReady":true,"dbReady":true,"dbError":null,
#   "dirs":{"root":["config.json","index.js","node_modules","package.json"],
#           "lib":"ERR ENOENT…","handlers":"ERR ENOENT…","services":"ERR ENOENT…"}}}
```

- `root` 四个文件齐、`lib`/`handlers`/`services` 是 `ENOENT` ⇒ **单文件打包在云端结构正确**（子目录本就不该存在）
- `node_modules` 已在 ⇒ **云端依赖装完了**（不用再等）
- `dbReady: true` ⇒ 云数据库连通（**注意：只是连通，数据还没导入，见 ③④**）
- **路径剥离行为已实测**：`/api/health` 正常返回；不带 `/api` 的 `/health` 被网关直接
  404 `INVALID_PATH`（**根本没进函数**）⇒ 关闭路径透传时**触发路径确实会被剥离**。
  信封模式请求的就是 `/api` 本身、真实路由在 body 里，**不受这个行为影响**。

---

## 为什么剩下的步骤要你手动做

| 类别 | 卡点 |
|---|---|
| 导出生产库 | 本机 `.env` 是 **sqlite**（`DB_DIALECT=sqlite`、`DB_STORAGE=./data/radio.db`），连不到服务器 MySQL |
| 控制台导入 / 导出 | 只有控制台能点 |
| ~~部署云函数~~ | ~~本机沙箱把 `reg.exe` 列入程序黑名单~~ —— **已完成，见 ②** |

---

## ① 配 HTTP 访问服务（云开发控制台）

路径：控制台 → 环境 `jy-radio-d1gdwmptl816ee6a9` → 左侧 **HTTP 访问服务**

1. 确认页面顶部 **「HTTP 网关」** 开关是**打开**状态
2. **域名管理** 里的**默认域名会自动生成并启用**（域名状态开关为开），记下它。
   本环境实际是：
   ```
   jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com
   ```
   形态为 `<envId>-<数字>.ap-shanghai.app.tcloudbase.com`（**不是**老的 `<envId>.service.tcloudbase.com`）
3. **路由管理** → 右上角 **「新增路由」**（弹窗标题「配置路由信息」）：

   | 字段 | 填什么 |
   |---|---|
   | 路由启用 | 保持**开** |
   | **访问路径** | **`/api`** ← 唯一必填项（不填时「确定」是灰的） |
   | 关联资源 | **云函数** + **`api`** |
   | 跨域设置 | 保持**开**；之后若 admin-web 与 API 不同源，要去左侧「跨域设置」把它的域名加进来 |
   | **路径透传** | **保持关闭**（信封模式不需要，见下） |
   | 身份认证 | 保持**关闭** |

   点「确定」。

> ⚠️ **「路由管理」配之前是空的（显示「暂无数据」）—— 空着等于这个域名下一个接口都不可用。**
> ⚠️ 我们用的是**信封模式**：真实 `method` / `path` / `body` / `token` / `query` 全放在 POST 的**请求体**里
>    （见 `api/httpBridge.js`）。控制台对「路径透传」的原文说明是：
>    *「关闭路径透传时，后端服务（资源）将收到**不带触发路径**的请求」* ——
>    而我们请求的就是触发路径本身（`/api`），真实路由在 body 里，因此**关着最省事**，一条路由就够。

- ⚠️ **不需要备案** —— 腾讯云自己的域名已备案。只有你想绑**自有域名**时才需要备案。
- ⚠️ 默认域名**有有效期**（且限频，官方说明仅限开发测试），到期在控制台点「**续期**」。
  失效表现是全站突然 404/502，最难查。
- ✅ 判据（**已实测通过**）：浏览器直接打开
  `https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api/health`
  → 返回 `{"code":0,"message":"ok",…}`（不是控制台 404 页）。
  等价命令行：`curl "https://<域名>/api/health"`。

## ② 部署云函数

产物已经是打好的**单文件**（`miniprogram/cloudfunctions/api/` 下只有 `index.js` + `package.json` + `config.json`）。
想确认，先跑：

```bash
node cloud/scripts/deploy-cloud.js        # 只打印，不执行
```

然后把打印出来的命令复制到**你自己的终端**跑：

```bash
cd /d/dev/wx-devtools
./cli.bat cloud functions deploy --env jy-radio-d1gdwmptl816ee6a9 --names api \
  --project "C:/Users/Administrator/radio-backend/miniprogram" -r </dev/null
```

（PowerShell 里把行尾的 `</dev/null` 去掉即可。）

- `-r` = 云端安装依赖，**必须加**（本地没有 `node_modules`，不加传上去是空壳）。
- ⚠️ **部署命令返回成功 ≠ 装完了**：云端 `npm install` 还要跑 1~3 分钟。窗口期内调用会报
  `-504002 ... Cannot find module`，**这长得像「文件没传上去」，其实是时序问题，等 1~2 分钟再验。**
- ✅ 判据：
  ```bash
  ./cli.bat cloud functions list --project "C:/Users/Administrator/radio-backend/miniprogram" \
    --env jy-radio-d1gdwmptl816ee6a9
  ```
  输出里出现 `api` 即成功。

## ③ 导出生产库（在服务器 `~/radio` 上跑，只读原库）

容器里 `WORKDIR /app`，且 DB_* 由 compose 注入 —— **在容器内跑最省事**（服务器不用装 node）。

⚠️ **`git pull` 只更新磁盘文件，不会影响已经跑起来的容器**（容器用的是构建那一刻的镜像快照）。
所以新代码要么重建镜像，要么直接 `docker cp` 塞进去 —— 后者更快、不重启服务：

```bash
cd ~/radio
git pull                                              # 拿到 cloud/migration/
docker cp cloud/. radio-backend:/app/cloud            # 免 rebuild（注意结尾的 /.）
docker exec -u root -i radio-backend node cloud/migration/export.js
docker cp radio-backend:/app/cloud/migration/out ./cloud/migration/
ls -la cloud/migration/out/
```

- `cloud/.` 结尾的 `/.` 是 docker 的语义：只拷**目录内容**；写成 `cloud` 会在目标已存在时套成 `/app/cloud/cloud`。
- `-u root`：`docker cp` 塞进去的文件属 root，容器默认跑在 `app` 用户下，**写不了 `out/` 目录**。
- 想走正规路线也行：`docker compose build radio-backend` + `up -d --force-recreate`（代价是几分钟 + 短暂重启）。

再把 `cloud/migration/out/` 整个目录拷回本机（或用 scp）。

- ⚠️ 结尾若打印 `error N 条`，**那些行没有导出** —— 先看 `out/_report.json` 处理掉再继续。
- ✅ 判据：`out/` 里有 16 个 `<collection>.jsonl` + `unique_keys.jsonl` + `sequence.jsonl` + `_snapshot.json`。

## ④ 导入云数据库（控制台）

**先把文件从服务器拿到本机**（控制台只能读本地文件）：

```powershell
# 在本机终端跑（<IP> 换成服务器 IP）
scp -r ubuntu@<IP>:~/radio/cloud/migration/out C:\Users\Administrator\radio-backend\cloud\migration\
```
> `cloud/migration/out/` 已在 `.gitignore`（含密码哈希），不会进版本库。

**集合已经建齐**（`POST /api/system/init-collections` → 18 个全部 `exists`），直接导入即可。

控制台 → 数据库 → 逐集合「导入」→ 选对应 `.jsonl` → 冲突处理选 **Upsert**。

> ⚠️ **后缀坑**：我们产出的是 `.jsonl`，而控制台的导入对话框通常只列 `.json`。
> 两种解法（任选）：
> ① 在文件选择框里把筛选器切到「所有文件」；
> ② 先复制一份 `.json`（内容不用改 —— 控制台要的 JSON 格式本身就是「**每行一个对象**」，也就是 JSON Lines）：
> ```powershell
> cd C:\Users\Administrator\radio-backend\cloud\migration\out
> Get-ChildItem *.jsonl | ForEach-Object { Copy-Item $_.Name ($_.BaseName + '.json') }
> ```

需要导入 **17 个**（18 个集合 − 空的 `message`）：
⚠️ `message.jsonl` 是**空的**（原表本来 0 行）—— 跳过它，集合已建好，空表就该是空的。

⚠️ **`unique_keys` 与 `sequence` 千万别漏**（漏了**不报错**）：
- 漏 `unique_keys` → 云库没有 UNIQUE 约束 → **能建出重名管理员且不报错**；
- 漏 `sequence` → 新建记录从 1 开始发号 → **与历史 id 撞号**，详情页点开是别人的数据。

## ⑤ 导出云库做基线（控制台）

控制台 → 逐集合「导出」JSON → 放进 `cloud/migration/cloud-dump/`。

⚠️ **文件名必须与集合名一致**（`submit.json`、`weekly_schedule.json`、`unique_keys.json` …）——校验按文件名认集合。

## ⑥ 双向校验（本机）

```bash
node cloud/migration/verify.js
```

看四组数字：正向缺失 / 反向孤儿 / 字段差异 / 结构问题，**全部为 0** 才算过。

## ⑦ admin-web 切 cloud

`admin-web/.env.local` 已建好（**已在 `.gitignore`，不进版本库**），核心就是两行：

```ini
VITE_REQUEST_MODE=cloud
VITE_CLOUD_API_URL=https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api
```

然后：

```bash
cd admin-web && npm run dev     # 本机看效果
cd admin-web && npm run build   # 正式产物
```

✅ 判据：能正常登录、投稿列表能加载、导出 xlsx 能下载。 —— **三项均已满足**（2026-09-29 陛下浏览器登录成功；
接口层含 xlsx 导出全绿）。另确认 `dist/` 内已含云域名、无 direct 的 `localhost:3000` 残留。

### ⑦ 的实测结论（2026-09-29 14:51）

**8 个真实管理端接口全部通过**（本机 → 云函数 HTTP 访问服务，信封模式）：

| 接口 | 结果 |
|---|---|
| `GET /admin/profile` | ✅ 返回 `teacher`（id 1 / role 0），无 password 字段 |
| `GET /admin/submit/list` | ✅ `total=18`，返回 5 条 |
| `GET /admin/stats/overview` | ✅ 四段汇总齐全 |
| `GET /admin/submit/week` | ✅ 周状态（含 `reviewEndAt` 等锚点） |
| `GET /admin/setting/list` | ✅ 17 条 |
| `GET /admin/switch/list` | ✅ 6 条 |
| `GET /admin/program/list` | ✅ `total=5` |
| `GET /admin/student/export` | ✅ 真返回 xlsx（`学生账号_2024级_xxx.xlsx`，base64 15 KB） |

另外验证：`POST /admin/login`（真账号 `teacher` + 错密码）→ `40101`，
说明云端 **bcryptjs 比对确实跑起来了**（依赖是纯 JS，无原生编译风险）。

**真实浏览器端到端**（Chromium 实机，非 curl）：勾 `XMLHttpRequest` 后用错密码点登录，抓到
`POST https://<域名>/api -> 200 | {"code":40101,...}` ⇒ **浏览器跨域直连成功**；
再注入 token 进 `/dashboard`，真实云端数据全部渲染（投稿总数 18 / 累计 258 人 / 近 7 天趋势 /
热门点歌 Top 5），**页内 JS 报错为空**。

截图：`shots/stage9-login.png`、`shots/stage9-dashboard-cloud.png`

> ✅ **已修（2026-09-29 陛下批准）**：`Dashboard.vue` 的「后端地址」改为跟着 `requestMode` 走 ——
> `requestMode === 'cloud' ? cloudApiUrl : VITE_API_BASE`；并给 `.kv .mono` 加 `min-width:0; overflow-wrap:anywhere`
> （云地址 ≈74 字符无空格，flex 子项默认 `min-width:auto` 会撑破卡片）。
> 实测 1600 视口：值折 2 行、`overflowPx = 0`、卡片与文档均无溢出、页内无 JS 报错。
> 截图：`shots/stage9-dashboard-sysinfo-fixed.png`

> ⚠️ **两件必须知道的事**（本次实测挖出来的）：

1. **云函数的 CORS 白名单含 `localhost`（任意端口），不含服务器 IP。**
   实测 `Origin: http://localhost:5173` / `:8080` → 回 `access-control-allow-origin`；
   `Origin: http://129.28.26.180` / `https://example.com` → **不回 CORS 头**。
   ⇒ 本机 `npm run dev` **不用配跨域**就能调云端；
   **正式上线时必须去控制台「跨域设置」加 admin-web 的真实域名**，否则浏览器会拦。

2. ~~**云函数没有配 `JWT_SECRET`，正在用代码里的兜底值。**~~ → ✅ **2026-09-30 已补配并验证通过**（详见下方「补配结果」）。
   当初的实测：用兜底密钥 `radio-station-default-secret` 自签的 token 能通过云端校验并取到数据
   ⇒ `process.env.JWT_SECRET` 为空。
   - 影响一（功能）：本次登录签发的 token 都挂在兜底密钥上，**之后一旦补配 `JWT_SECRET`，
     这些 token 全部失效**，管理人员/学生要重新登录一次。**要配就趁现在配。**
   - 影响二（安全）：兜底值写死在仓库里，拿到代码的人能**伪造超管 token**。
     ⚠️⚠️ **而本项目仓库是公开的**（`https://github.com/Nailoonger/radio-backend` → HTTP 200，
     `raw.githubusercontent.com` 匿名可拉源码）⇒ **这个兜底值等于全世界都知道**，
     任何人不登录就能自签一个 `{id:1, username:'teacher', role:0}` 的 token 直接调管理端接口
     （读/改点歌设置、看学生名单、**导出学生账号 xlsx**）。
     **不是理论风险 —— 本文档上面那次「8 个管理端接口全绿」的实测，就是我自己用这个办法做的。**
     三个出处（都是公开文件）：`cloud/cloudfunctions/api/lib/auth.js:21`、
     `miniprogram/cloudfunctions/api/index.js:1368`（打包产物）、`src/config/index.js:12`（原 Express 侧）。
     ⇒ **补配 `JWT_SECRET` 是当前最高优先级的一件事。**
   - 顺带自查（同源问题）：控制台看一眼**云数据库的权限设置**。若被设成「所有人可读」，
     那么连伪造 token 都不需要，直接读库 —— 走云函数不受该权限限制，所以应保持
     「仅创建者可读写 / 所有人不可读写」。
   - **操作步骤（陛下已批准补配）**：
     1. 先去服务器看老值：`grep '^JWT_SECRET' ~/radio/.env`
     2. 判断取哪个值：
        - 老值是**强随机串**（几十位乱码）⇒ **直接复用**，服务器时代没到期的 token 继续有效，学生不用重登；
        - 老值是空 / 占位符（`please-change-me-in-production`）⇒ **换一个新的强随机值**
          （`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`），
          代价是所有人重登一次 —— 迁移期重登一次是合理的。
     3. 控制台 → 云开发 → 云函数 → `api` → **配置 → 高级配置 → 环境变量** → 新增
        `JWT_SECRET`（值同上）→ 保存。
        （界面已确认，2026-09-30：`api` 的「配置」页里，「高级配置」分组下有「环境变量」区域。）
        顺便确认 `JWT_EXPIRES_IN`：不填时云端默认 `7d`，与服务器一致，可不填。
        ⚠️ 只需加 `JWT_SECRET` **一行**；保存后**等 1~2 分钟**让配置下发到实例再验。
     4. 等配置下发到实例（一般几十秒；保险起见等 1~2 分钟）。
     5. **反向验证（判据）**：用**兜底密钥**自签一个 token 去调 `/admin/profile`，
        必须从「能取到数据」变成 **`40101`** ⇒ 说明新 `JWT_SECRET` 真的生效了。
        ⚠️ 只验证「能登录」是不够的 —— 配错了照样能用兜底值登录成功。

   **✅ 补配结果（2026-09-30，陛下已配，我复验）**

   验证脚本：`cloud/scripts/verify-jwt-secret.js`（纯 Node 手写 HS256，不引依赖）
   ```bash
   NEW_JWT_SECRET='<填的那串>' node cloud/scripts/verify-jwt-secret.js
   ```

   | 项 | 用例 | 实测 | 结论 |
   |---|---|---|---|
   | A | 兜底值 `radio-station-default-secret` 自签 → `GET /admin/profile` | `{"code":40101,"message":"登录已过期，请重新登录","data":null}` | ✅ 已失效 |
   | B | 新值自签 → `GET /admin/profile` | `{"code":0,"data":{"id":1,"username":"teacher","nickname":"指导老师","role":0,...}}` | ✅ 生效 |

   ⇒ **兜底密钥伪造超管 token 的路已被堵死**，新密钥签发/校验自洽。

   ⚠️ 两点实测教训（下次别踩）：
   1. **判据只能看响应体的 `code`，不能看 HTTP 状态码、也不能看 `data` 有没有值。**
      本项目 **HTTP 恒 200**，业务结果全在 `code` 里；被拒时 `data` 是 `null`，
      而 `null !== undefined` 为真 —— 脚本初版用 `data !== undefined` 判断，
      把「拒绝」误报成了「通过」（差点得出相反结论）。
   2. 配好后**所有存量 token 作废**（学生 + admin-web 都要重登一次）—— 预期行为，不是故障。

### 上线方式：备案是硬约束（先把事实钉死）

**实测事实（2026-09-29，本机直连、绕开本机代理）**

| 探测 | 结果 | 含义 |
|---|---|---|
| `nslookup jyradio.online` | → `129.28.26.180` | 解析正确，确实指向服务器 |
| `http://jyradio.online` | **301 → `https://jyradio.online/`** | 80 端口**没被拦**，请求真到了 nginx |
| `https://jyradio.online` | **TLS 握手被 RST**（`curl: (35) Recv failure: Connection was reset`） | ❌ 域名在 TLS 层被拦 |
| `https://129.28.26.180`（纯 IP） | **HTTP 200**、握手正常 | ✅ 服务器 443 与证书本身都是好的 |

⇒ **`jyradio.online` 未备案**（陛下确认），拦截发生在 **TLS 握手阶段（按 SNI 识别域名）**，
**与服务器、证书无关**。这同时解释了小程序当初的 `url not in domain list`
（小程序的 request 合法域名**必须已备案**，未备案根本加不进去）。
也说明：**用域名访问时 80 会 301 跳 https，而 https 被 RST ⇒ 域名这条路现在是死的。**

> ⚠️ **我先前判断错了，记录在案**：把「nginx 里配了 443 + 证书」当成「已备案」。
> **证书（Let's Encrypt 等免费证书）与 ICP 备案完全无关** —— 别再拿证书当备案的证据。

### 备案约束下，每个方案的域名能不能用

| 方案 | 站点域名 | 要备案吗 |
|---|---|---|
| **A′ 服务器继续托管（现状）** | 纯 IP `https://129.28.26.180` | ✅ **不用**（IP 访问不受备案限制） |
| A 服务器继续托管 | `jyradio.online` | ❌ 要（所以现在用不了） |
| **B 云开发静态托管** | 腾讯云默认域名 `*.tcloudbaseapp.com` | ✅ **不用**（腾讯云自己的域名，已备案） |
| B′ 云开发静态托管 | 绑 `jyradio.online` | ❌ 要 |
| C nginx 反代 `/api` | 跟站点域名走 | 同上 |

⇒ **真正「不需要备案」的只有两条路**：

1. **A′：继续用服务器 + IP 访问** —— 一条命令今天就能上线（服务器放 `admin-web/.env.local`）。
   代价：IP 难记、证书与 IP 不匹配（浏览器会报警告）、微信内体验差。
   **陛下现在就是这么在用的**（小程序侧走云开发，管理后台走 IP）。
2. **B：云开发静态托管 + 腾讯云默认域名** —— 能彻底停服务器，免备案。

> ⚠️⚠️ **但默认域名有生产限制**（官方 `docs.cloudbase.net/service/alias`，必须知道）：
> - 浏览器**直接访问**（navigate 请求）会先弹**「访问提示中间页」**，访客要点「确定访问」才进得去；
> - 非导航请求会被加上 `Content-Disposition: attachment` 头
>   （**实测坐实**：`/api/health` 响应里就有这个头，只是 axios 不受影响）；
> - 官方原话：「**默认域名仅建议用于开发测试，严禁用于正式生产环境或分发给大规模用户**」，
>   且「若检测到访问量异常波动，平台保留采取禁止访问等风控措施的权利」。

⇒ **诚实结论：不备案就没有「既免备案、又完全合规好用」的方案。** 只有三个选择：
① 接受 IP 访问（A′，最省事）；② 接受默认域名的中间页（B，能停服务器）；
③ **去备案**（备案通过后 `jyradio.online` 可以继续绑服务器，也可以绑云开发静态托管 ——
腾讯云已支持通过云开发办理备案）。备案是唯一能让「域名 + 免服务器 + 正规」三者兼得的路径。

### 各方案做法与代价

| 方案 | 做法 | 代价 |
|---|---|---|
| **A′ 服务器 + IP** | 服务器 `~/radio/admin-web/.env.local` 放同两行（`.dockerignore` 没排它，compose 的 build context 就是 `./admin-web`，容器内 `npm run build` **读得到**）→ `docker compose build admin-web && up -d` | 一条命令搞定；文件未跟踪，重新 clone 会丢。**要配控制台跨域**加 `https://129.28.26.180`（实测此来源当前**不在**白名单） |
| **B 云开发静态托管** | 本机 build → 上传 `dist/` | 两个待确认：① 静态托管在**当前免费额度下能不能开**（官方历史信息提过需「按量付费」环境，2025–2026 又有「免费体验版不可用静态托管」的说法）② 部署得用 CloudBase CLI（`tcb hosting deploy`）或控制台「文件管理 → 上传」—— **微信开发者工具的 CLI 里没有 hosting 命令**（官方命令索引里云开发只有 `cloud env` / `cloud functions`） |
| **C 服务器 nginx 反代 `/api`** | `admin-web/deploy/nginx-admin.conf` 加一条 `location /api { proxy_pass <云域名>/api; }`，`VITE_CLOUD_API_URL` 写相对路径 `/api` | **永久免 CORS**；但仍然用 IP（或必须备案），且服务器彻底摘不掉 |

> **建议**：**先走 A′ 上线**（一条命令、零风险，跟你现在访问方式一致），观察几天；
> 同时去控制台确认「静态网站托管」能不能开。若能开、且你不想再续费服务器，再走 B。
> 想彻底正规（域名可用 + 免服务器）就去备案，备案后再把 `jyradio.online` 绑到云开发静态托管。
>
> ⚠️ 若将来把域名绑到 CloudBase 且要退订服务器：**先把备案的接入信息变更到 CloudBase**，
> 否则备案可能因「接入信息不符」被注销。
>
> 现在**不必马上决定**：本机 `npm run dev` 已经能完整验功能。



---

## ⑧ 小程序切 cloud —— 「别人也能用」的真正卡点（2026-09-29 发现）

⚠️ **先说结论：学生侧一直不可用，卡点不在服务器、不在备案，在 `miniprogram/app.js` 一行配置。**

```js
// 改之前
baseURL: 'http://129.28.26.180/api',   // ❌ IP + http
requestMode: 'direct',                  // ❌ 走 wx.request，触发「request 合法域名」校验
```

微信正式版**只允许 HTTPS + 已备案域名**，所以 `direct` 模式下学生端必然报
`url not in domain list` —— 这正是当初启动整个云开发迁移的那个报错，但**开关一直没拨过去**。

✅ **已改成** `requestMode: 'cloud'`（2026-09-29）：

- `cloud` 走 `wx.cloud.callFunction`，**同环境调用不过「合法域名」校验** ⇒ **免备案**；
- 全项目实测：小程序里**没有** `wx.uploadFile` / `wx.downloadFile` / `wx.connectSocket`，
  唯一的网络调用就是 `utils/request.js`（`direct` 分支）⇒ 切 `cloud` 后**所有请求都走云函数，
  一条都不再需要域名**；
- 云通道实现是完整的（`request.js:93-127` 有真正的 `callFunction` 分支，
  两种模式返回值与错误语义一致，页面代码无感）；
- 云函数侧实测：`POST /user/login/account`（真学号 `20240201` + 错密码）
  → `40101 账号或密码错误`（HTTP 200）⇒ **查库 + bcryptjs 全正常**；数据也已迁移完毕。
- `node --check miniprogram/app.js` 通过。

### ✅ 体验版真机验证通过（2026-09-30）

陛下实测：**体验版不再报错、可以正常登录**，而且**不需要再开「不校验合法域名」的开发模式**
—— 这正是云通道生效的判据（之前必须勾那个开关才能在工具里跑）。

**另做了学生端全量只读烟测**（本机自签学生 token `openid=20240201 / uid=3 / pv=0`，全部 GET、零写操作）：

| 接口 | 结果 |
|---|---|
| `/user/me`、`/user/profile` | ✅ |
| `/user/submit/my`、`/quota`、`/window`、`/week`、`/notice`、`/timeslots`（15 个时段） | ✅ |
| `/user/message/my` | ✅ |
| `/user/program/current`（null = 今天无直播，正常）、`/weekly`、`/schedule` | ✅ |
| `/user/notice/list`（3 条） | ✅ |
| `/user/submit/1` | ⚠️ `40401 投稿不存在` —— **正确行为**：该投稿不属于这个学生（归属校验生效） |

⇒ **学生端全部只读路径在云端健康**，13/13 正常。

### ⚠️ 必须陛下动手：上传正式版（体验版只有体验成员能用）

1. 微信开发者工具打开 `miniprogram/`
2. 上传 → 提交审核 → 发布

> ⚠️ **体验版通 ≠ 学生能用**。体验版只有你加进「体验成员」的那几个人看得到；
> 全体学生现在跑的**还是线上旧版本**（`direct` 模式，照样报错）。**必须发布正式版才算真的「别人也能用」。**

### ⚠️ 切云之后出现的新单点依赖（别忘）

学生侧现在**完全依赖云开发环境**（不再有服务器兜底）。上线前确认几件事：

- **免费额度与到期**：本环境是「校园版个人版，**前 6 个月免费**」（`cloud/README.md:24`、`app.js:43`）。
  过期/超额的表现是全站突然不可用，**最难查**。到期前要在控制台看用量、决定续费还是切回 `direct`。
- **HTTP 访问服务的默认域名有有效期**，到期在控制台点「**续期**」（5 分钟生效，`stage9-admin-web-plan.md:130`）。
- 回退开关都还在：小程序改回 `requestMode: 'direct'` 重新上传即切回服务器
  （但注意 `direct` 的 `baseURL` 是 `http://IP`，正式版不可用 ⇒ 真要回退得先解决域名/备案）。

### 回退

把 `requestMode` 改回 `'direct'` 重新上传即可 —— `baseURL`、服务器、MySQL、Docker 一行未动。

> 注：admin-web（老师用）是网页，不受「合法域名」限制，用 IP 就能开；
> 要"干净无感"才需要备案（见上文备案一节）。**学生侧和老师侧是两条独立的线。**

---

## 随时切回（两条线各回各的）

**admin-web（老师侧）**：把 `VITE_REQUEST_MODE` 改回 `direct`（或删掉这一行）重新 build 即可 ——
原 Express 后端、MySQL、Docker 链路**一行都没动**。

**小程序（学生侧）**：把 `miniprogram/app.js` 的 `requestMode` 改回 `'direct'` 重新上传即可 ——
`baseURL`、云函数、云数据库都还在。

**建议：切 cloud 后先别急着停服务器**，观察几天确认稳定，再决定要不要停。

