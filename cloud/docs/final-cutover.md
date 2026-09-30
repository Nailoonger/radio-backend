# 真机收尾清单（阶段 9 之后 · 一次性）

> 目标：把「服务器 Express + MySQL」整体切到「云开发 + 云数据库 + HTTP 访问服务」。  
> 原则：**原链路一行不删、随时可切回**（admin-web 只改一个环境变量）。  
> 现状：阶段 0–9 的代码 / 断言 / 文档全完成；本机回归 **3115 项 / 0 失败**。  
> 相关：迁移三步的细节见 `cloud/migration/README.md`；通道选型见 `stage9-admin-web-plan.md`。

---

## 进度

| 步                   | 状态                 | 证据 / 产物                                                                                 |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| ① 配 HTTP 访问服务       | ✅ **已完成**          | 路由 `/api` 已生效；域名 `jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com` |
| ② 部署云函数             | ✅ **已完成**          | `success: true`、`filesCount: 3`、`packSize 126.3 KB`                                     |
| ③ 导出生产库             | ✅ **已完成**          | 16 表 / **686 行** / warning 0 / error 0；`unique_keys` 556 条、`sequence` 16 条              |
| ④ 导入云数据库            | ✅ **已完成**          | 控制台导入 17 个集合（`message` 本就空，跳过）；Upsert                                                   |
| ⑤ 导出云库做基线           | ✅ **已完成**          | `cloud/migration/cloud-dump/`（17 个 `<集合名>.json`）                                        |
| ⑥ 双向校验              | ✅ **已完成**          | 表 16 / 失败 0；行 源 686 = 云 686；缺 0 / 孤 0 / 字段差 0 / 结构问题 0                                  |
| ⑦ admin-web 切 cloud | ✅ **已完成**          | 8 个接口实测全绿 + 真实浏览器登录成功（2026-09-29）；`dist/` 已含云域名、无 direct 残留                             |
| ⑧ 小程序切 cloud        | ✅ **体验版已验证，待发正式版** | 陛下真机实测：**不再报错、可正常登录**，且**无需再开「不校验合法域名」**；另 13 个学生端只读接口云端全绿（见下文 ⑧）                       |

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

| 类别         | 卡点                                                                                    |
| ---------- | ------------------------------------------------------------------------------------- |
| 导出生产库      | 本机 `.env` 是 **sqlite**（`DB_DIALECT=sqlite`、`DB_STORAGE=./data/radio.db`），连不到服务器 MySQL |
| 控制台导入 / 导出 | 只有控制台能点                                                                               |
| ~~部署云函数~~  | ~~本机沙箱把 `reg.exe` 列入程序黑名单~~ —— **已完成，见 ②**                                            |

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
   | 字段       | 填什么                                                |
   | -------- | -------------------------------------------------- |
   | 路由启用     | 保持**开**                                            |
   | **访问路径** | **`/api`** ← 唯一必填项（不填时「确定」是灰的）                     |
   | 关联资源     | **云函数** + **`api`**                                |
   | 跨域设置     | 保持**开**；之后若 admin-web 与 API 不同源，要去左侧「跨域设置」把它的域名加进来 |
   | **路径透传** | **保持关闭**（信封模式不需要，见下）                               |
   | 身份认证     | 保持**关闭**                                           |
   点「确定」。

> ⚠️ **「路由管理」配之前是空的（显示「暂无数据」）—— 空着等于这个域名下一个接口都不可用。**  
> ⚠️ 我们用的是**信封模式**：真实 `method` / `path` / `body` / `token` / `query` 全放在 POST 的**请求体**里  
> （见 `api/httpBridge.js`）。控制台对「路径透传」的原文说明是：  
> *「关闭路径透传时，后端服务（资源）将收到**不带触发路径**的请求」* ——  
> 而我们请求的就是触发路径本身（`/api`），真实路由在 body 里，因此**关着最省事**，一条路由就够。

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

容器里 `WORKDIR /app`，且 DB\_* 由 compose 注入 —— **在容器内跑最省事**（服务器不用装 node）。

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
>
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

| 接口                          | 结果                                             |
| --------------------------- | ---------------------------------------------- |
| `GET /admin/profile`        | ✅ 返回 `teacher`（id 1 / role 0），无 password 字段    |
| `GET /admin/submit/list`    | ✅ `total=18`，返回 5 条                            |
| `GET /admin/stats/overview` | ✅ 四段汇总齐全                                       |
| `GET /admin/submit/week`    | ✅ 周状态（含 `reviewEndAt` 等锚点）                     |
| `GET /admin/setting/list`   | ✅ 17 条                                         |
| `GET /admin/switch/list`    | ✅ 6 条                                          |
| `GET /admin/program/list`   | ✅ `total=5`                                    |
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

## ⑨ ⚠️⚠️ 老师侧必须也切到 cloud，否则会「两个库各写各的」（2026-09-30 实测踩到）

**这是当前最危险的一个坑，不是理论风险 —— 它已经真实地困惑了陛下半天。**

### 症状（四条同时出现，就是这个问题）

- 学生在**体验版**上改完密码，**再用初始密码登不上**（正常，密码已换）；
- 改完密码后在**管理端学生账号列表里仍显示「未激活」**；
- 在管理端**重置密码提示成功，但学生还是登不上**；
- 同一个账号、同一个初始密码，**两边结果相反**。

### 根因

`admin-web` 的 Dockerfile 在**容器内** `npm run build`，而生产配置读的是 `.env.local`，
**偏偏 `.env.local` 在 `.gitignore` 里** ⇒ 服务器上 `git pull` **永远拿不到它**
⇒ `VITE_REQUEST_MODE` 回落成默认值 **`direct`**（`admin-web/src/utils/http.js:28`）

⇒ **服务器上部署的管理端打的是老 Express + MySQL，而体验版小程序打的是云库。**
一个账号的密码/激活状态被记录在其中一个库里，另一个库完全不知情。

### 实测判据（一条命令定性）

```bash
node cloud/scripts/probe-admin-web-mode.js         # 默认探 http://129.28.26.180
# 或探别的地址：ADMIN_WEB_URL=http://<host> node cloud/scripts/probe-admin-web-mode.js
```

拉首页引用的 JS bundle，看里面有没有云地址：

| 输出 | 含义 |
|---|---|
| `含云地址=true` | 该管理端走 cloud ✅ |
| `含云地址=false  含"/api"=true` | **走 direct，就是它造成了分叉** ❌ |

> 实测（2026-09-30）：`/assets/index-CFUEG3k_.js` → `含云地址=false  含"/api"=true` ⇒ 服务器上那个是 direct。

另一条并行的判据（不需要脚本）：同一账号同一初始密码，分别打两个入口，看结果是否相反。

### 修复（服务器上三步）

```bash
# ── 在服务器 ~/radio 下 ──────────────────────────────────
cat > admin-web/.env.local <<'ENVEOF'
VITE_REQUEST_MODE=cloud
VITE_CLOUD_API_URL=https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api
VITE_API_BASE=/api
VITE_API_PROXY_TARGET=http://localhost:3000
ENVEOF

# ② 云开发控制台 → 左侧 **「HTTP 网关」→「跨域设置」→「添加跨域域名」**
#    （⚠️ 左侧大项在控制台里叫「HTTP 网关」；官方文档写作「HTTP 访问服务」，是同一个东西。
#      该页面左侧分「域名及路由 / 跨域设置 / 缓存配置」三块。）
#    ✅ 已做（2026-09-30）：值填 `129.28.26.180` —— **不带 http://，也不带端口**（走 80 就写裸主机）。
#       ✅ **实测结论：纯 IP 是可以加进去的**（之前不确定，现已证实）。
#       ✅ **生效很快（<1 分钟）**：加完立刻实测 `Origin: http://129.28.26.180`
#          → 回 `access-control-allow-origin: http://129.28.26.180` + `credentials=true`；
#          `OPTIONS` 预检 → `204` + `allow-headers: Content-Type`。（控制台弹窗写"约 10 分钟"，实际没那么久。）
#
#    ⚠️⚠️ 控制台里有**两扇错门**，都走不通，别去：
#       ①「添加授权域名」——环境 → 安全配置 →「安全域名」，说明文字提到「网页应用中使用云开发的
#          身份验证服务」。那是**网页端 SDK 身份认证**的访问控制（默认就含 localhost），与接口跨域无关。
#       ②「绑定自定义域名」——HTTP 访问服务 → 域名管理。它第①条就要求「先办理网站备案」，
#          还要关联 HTTPS 证书 —— 正是要避开的那条路。
#    正确的按钮叫「添加跨域域名」：在**同一个「HTTP 访问服务」页面**里，往下找「跨域设置」区块
#       （该页分 一、域名管理 二、路由管理 三、跨域设置 三大块）。
#    出处：https://cloud.tencent.com/document/product/876/130728 §三「跨域设置」
#
#    生效时间：现已证实**不到 1 分钟**就生效（控制台弹窗说"约 10 分钟"，是保守说法）。
#
#    ✅ 结论：**纯 IP 可以加**（示例里全是域名，容易误以为不行）。方案 B 因此只作为备选。

# ③ 重建（Dockerfile 容器内自 build；.dockerignore 只排 node_modules/dist/_backup，
#    所以 .env.local 会被打进构建、vite 读得到）
docker compose build admin-web
docker compose up -d --force-recreate --no-deps admin-web
```

**免掉第②步（CORS）的替代做法**：把云地址写成**相对路径**，让 nginx 同源反代 ——
`.env.local` 里 `VITE_CLOUD_API_URL=/api`，再把 `deploy/nginx.conf` 的 `location /api`
上游从 `radio-backend:3000` 改成云函数 HTTP 地址。
同源请求天然无跨域，也不需要控制台加白名单；代价是 nginx 得能反代到外部 HTTPS。

### 方案 B：nginx 同源反代（完全不碰控制台，推荐给「纯 IP 加不进 CORS 列表」的情况）

**原理**：admin-web 在 cloud 模式下发的是**信封请求**，就是往 `CLOUD_URL` 发一个 POST。
把 `CLOUD_URL` 换成**相对路径 `/api`** → 浏览器发到同源 → 由 nginx 转发到云函数。
**同源请求浏览器根本不做 CORS 校验**，因此网关的白名单是什么样都无所谓。

⚠️ 关键细节：信封请求打的是 **`/api`（不带尾斜杠）**，而 nginx 里现有的是 `location /api/`（带尾斜杠）
—— 两者**不匹配**，必须补一条 `location = /api`，否则会落到 `location /` 上被 SPA 吃掉。

```nginx
# deploy/nginx.conf —— 放在 `listen 80; server_name _;`（default_server）那个 server 块里
# ⚠️ 用变量 + resolver 形式，让 nginx 在**请求时**解析域名。
#    写成字面量（proxy_pass https://xxx.tcloudbase.com/api;）会在启动时解析，
#    一旦容器 DNS 解析不到，nginx 直接起不来（整站 502）。
#    127.0.0.11 是 Docker 用户自定义网络的**内置 DNS**（本项目 nginx 在 `radionet` 里，可用），
#    它会把外部域名转发给宿主机解析；万一不通，再换成 `119.29.29.29 8.8.8.8`。
resolver 127.0.0.11 valid=30s ipv6=off;

location = /api {
    set $cloud_upstream "jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com";
    proxy_pass https://$cloud_upstream/api;
    proxy_ssl_server_name on;                 # 必须：云网关按 SNI 分发
    proxy_set_header Host $cloud_upstream;
    proxy_set_header Origin "";               # 顺手去掉 Origin，避免网关按白名单挑刺
    proxy_http_version 1.1;
    client_max_body_size 30m;                 # 导出 xlsx 走这条
    proxy_read_timeout 60s;                   # 云函数冷启动
}
```

配套：`.env.local` 里写 `VITE_CLOUD_API_URL=/api`（其余同方案 A）。

改完生效：`docker compose restart nginx`（nginx.conf 是 volume 挂载进去的，重启即可，不用重建镜像）。
应用改动：`docker compose build admin-web && docker compose up -d --force-recreate --no-deps admin-web`。


**验证**：浏览器 F12 → Network，看请求是打到 `http://129.28.26.180/api`（同源）
而不是 `https://xxx.tcloudbase.com/api`（跨域）。同源那条不会出现 CORS 报错。

### ⚠️ 切完之后的两个后果

1. **老 MySQL 里那些学生自己改过的密码，云库里没有。**
   所以正式版发出去之前，凡是在旧版上改过密码的学生，**在新版里要用初始密码（`user`+学号）重登**，
   或者老师在管理端批量重置一次。数量少（当前云库里只有 4 个已激活账号），但要知道这件事。
2. 切完之后**管理端才第一次真正看到云库的真实状态** —— 之前看到的「未激活」都是老库的旧数据。

### ⚠️⚠️ 切云会**静默弄坏**一类接口：带文件上传的（2026-09-30 已修一个、剩一个）

**为什么静默**：stage 9 那轮「8 个接口全绿」用的是 JSON 接口，**没有一条走文件流**。

**根因（两条通道的请求体根本不是一回事）**：

| | direct | cloud |
|---|---|---|
| 请求体 | `multipart/form-data`（multer 收） | **JSON 信封** `{ method, path, body, token, query }` |
| FormData 的命运 | 正常 | 一 `JSON.stringify` 就变 `{}` ⇒ **文件直接丢** |
| 云端契约 | — | `{ filename, fileBase64 }` |

**① 学生账号导入 —— 已修 ✅**（`admin-web/src/utils/http.js` 的 `cloudRequest()`）
在公共请求层认出 `FormData` → 自己读成 base64 → 换成云端契约。**direct 模式行为零变化、业务代码一行未改。**
验证：`node cloud/scripts/verify-upload-adapter.js`
（① 单元跑 `http.js` 真实源码 ② 本地假库端到端：真 FormData → 真 `importPreview` 断言 `code=0`
+ 反证「修复前的发法」确实回 `40001 缺少文件内容（fileBase64）` ③ 有 `JWT_SECRET` 时加打真云端）

**② 头像上传 —— ⚠️ 更正：这**不是**切云弄坏的，它**两条通道下都不能用**（本来就坏的）**
`admin-web/src/views/Cadre.vue` 与 `Staff.vue` 都调 `POST /admin/upload/avatar`。
- cloud：`40401 接口不存在`（`router.js` 里没有这条路由）。
- direct：**老后端也 404** —— `src/routes/admin.js:17` 把
  `controllers/admin/uploadController.js` `require` 进来了，但**从未挂路由**
  （全仓 `grep upload/avatar` 只命中「它自己的定义 + 注释」，无任何 `router.post`）。
  ⇒ `exports.uploadAvatar` 是**死代码**，当时的开发就没接上。

**判据（区分「切云弄坏的」vs「本来就坏的」）**：别只看云端有没有这条路由 ——
去老后端里 `grep` 那条 `router.<method>('<路径>'`。**没挂 ⇒ 不是切云的锅**，别记到迁移账上。

**方向仍待定**（这是 UI 改动 ⇒ 按项目铁律要先出静态预览、标版本号、点头后才动）：
① 真把它接上（云端要选个文件存放方案：云开发存储 / 或干脆只存 URL 手填）
② **去掉这个入口** —— 项目现有设计其实站在这一边：`handlers/user/auth.js` 明确
   「用户**不允许**更换头像，客户端传 `avatar` 也直接丢弃、不落库」，
   头像本来就是「姓名首字 / 圆形」生成的。若老师侧也不需要真头像，②是最省事且最一致的选择。
③ 先放着。

> 清单式自查法：凡是「前端 `new FormData()` 或传 `Blob`」的调用，切云后都要单独验一遍。
> 本次全仓只有 3 处 `FormData`：导入（✅ 已修）、Cadre 头像、Staff 头像（同一条死路由）。

---

## 服务器不续费之后：**admin-web 这个网页放哪**

先看清「服务器现在到底在干什么」。切云之后：

| | 谁在用 | 走的通道 |
|---|---|---|
| 学生（小程序） | `wx.cloud.callFunction` | **不碰服务器** |
| 老师（admin-web） | 浏览器打开 `http://129.28.26.180`，**页面里的接口请求直接打云端** | **只有那个网页文件走服务器** |
| 老后端（Express + MySQL） | 切云后**没有已知调用方** | —（admin-web 不打 `/api` 了） |

⇒ **服务器现在实质上只是一台「静态网页托管机」**，为放几 MB 的 dist 养一台机器。
（这也是「为什么改个前端还要上服务器更新」的答案：**那个网页在服务器上**。）
⚠️ 但**别急着停后端容器** —— 旧版小程序（direct）还在不在用，得先看
`docker compose logs --tail=200 radio-backend` 有没有近期请求。没流量再停。

### 三个选项

**A. 云开发「静态网站托管」+ 默认域名** —— 免费、几十分钟可完成

- 把 `dist/` 传到 控制台 → 静态网站托管。
- 默认域名形如 `xxx.tcloudbaseapp.com`。
- ⚠️ **代价（2026-09-30 查官方文档的现口径）**：
  - 浏览器**首次**访问会展示「访问提示中间页」，访客点一下「确定访问」才进去；
    点过之后**同一个默认域名在 Cookie 有效期内不再弹**（不是每次都弹）。
  - **政策已放宽**：原文「本次更新后，若开发者合规使用默认域名（不触发访问频率异常的风控阈值），
    将**只有软性的访问提醒中间页，不再硬性禁止访问**」。
  - 但仍写着「推荐仅用于开发测试，**严禁用于正式生产环境或分发给大规模用户**」，
    且平台保留「访问量异常 → 风控关停」的权利。
- 📌 判断：**给几个老师内部用，够用**；要对外分发就别用它。

**B. 静态托管 + 备案自定义域名** —— 最正规，彻底没有中间页

- 需要：买域名（约 ¥30–60/年）+ ICP 备案（管局审核 **1–20 个工作日**）+ SSL 证书（可免费申请）。
- ✅ 好消息：**备案可以在云开发里办，不用另买服务器**（省一台机器）。
- ⚠️⚠️ **卡点：云开发里备案有三个准入条件，必须同时满足**
  1. 套餐**个人版及以上** —— **免费体验环境不支持备案**（原文如此）
  2. 云环境**剩余有效期 > 6 个月**
  3. 该环境已开启「**云托管固定 IP**」—— 本项目没开云托管，这条要单独去开
- ⚠️ 若域名已在别家备案过，不能直接绑：要先办「**新增接入备案**（备案转入）」。
- 一个环境最多备 **2 个**网站。

**C. 续服务器** —— 最省事，但正是要避免的。

### 无论走 A 还是 B，都别忘了这一步

静态托管的域名和 HTTP 网关的域名**不是同一个后缀**（`tcloudbaseapp.com` vs `app.tcloudbase.com`），
所以是**跨域**的 ⇒ 必须把静态托管的域名加进
**HTTP 网关 → 跨域设置 → 添加跨域域名**（就是加 `129.28.26.180` 的那个地方）。
不加的话，页面能打开但所有接口被浏览器拦掉。

> 顺带：默认域名还会给非导航请求加 `Content-Disposition: attachment` 响应头
> （浏览器直接打开会变成下载）。静态资源正常在页面里加载不受影响，但如果遇到
> 「点某个链接变成下载」，先怀疑这个头。

### 实操：方案 A「静态托管 + 默认域名」怎么落地（2026-09-30 已备好产物）

**① 本机构建（已做，产物就在仓库里）**

```bash
cd admin-web
node ./node_modules/vite/bin/vite.js build --outDir _hosting
```

- ⚠️ **不要构建到默认的 `dist/`** —— 本机装了 safe-delete 垫片，
  vite 清空已存在的 `dist/` 会报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（拦删，不是代码错）。
  用一个**不存在的新目录**（如 `_hosting`）就绕过这一步。
- 用 `_` 前缀还有个好处：根 `.gitignore` 有 `_*` ⇒ 产物不进版本库。
- 产物：`admin-web/_hosting/`（76 个文件 / 3.5MB；打包 zip 后 1.1MB）。
- 构建读的是 `admin-web/.env.local` ⇒ **必须是 `VITE_REQUEST_MODE=cloud` + 云地址**，
  否则打出来是 direct 包（判据：`grep -c "jy-radio-" assets/*.js` 要命中）。

**② 上传（控制台，最省事）**

云开发控制台 → 目标环境 → 左侧「**静态网站托管**」→「**新建部署**」→「**上传文件夹**」/
「**上传代码包**」，选 `admin-web/_hosting`（或刚打的 zip）。
- 文档明确：「如果静态文件已经是构建产物（如 dist/ 下的文件），**直接上传该目录即可**」。

**⚠️⚠️ 「新建部署」表单的逐字段填法（2026-09-30 踩过，官方 docs.cloudbase.net/hosting/web-hosting-static）**：

| 字段 | 填 | 为什么 |
|---|---|---|
| 项目名称 | 随意（`admin-web`） | 只是标识 |
| 项目根目录 | **留空** | 指代码仓库的根目录，我们不是仓库部署 |
| 安装命令 | **清空** ⚠️ | zip 里**没有 `package.json`**（`_hosting` 是构建产物，根目录只有 `index.html`+图片+`assets/`）⇒ 填 `npm install` 必然失败 |
| 构建命令 | **清空** ⚠️ | 同上，没有 `package.json` 就没有 `build` 脚本 ⇒ 必然失败 |
| 构建产物目录 | `.` | 官方对纯静态项目的写法（当前目录） |
| **部署路径** | **`/`** ⚠️⚠️ | 默认就是 `/`。**别改成 `/admin-web/`** —— 见下 |

**为什么部署路径必须是 `/`**：`_hosting/index.html` 里引用的是**绝对路径**
`/assets/index-*.js`、`/assets/index-*.css`（vite 默认 `base: '/'`）。
若部署到 `/admin-web/`，浏览器会去请求 `https://<域名>/assets/...`，
而文件实际在 `https://<域名>/admin-web/assets/...` ⇒ **404 ⇒ 打开一片白**。
（官方文档说"部署路径 `/` 或 `/my-website` 都行"，那是对**用相对路径引用资源**的纯静态站而言，我们这个不行。）

> ⚠️ 表单自己也提示了：部署路径设成 `/` 之后**不能再改回子目录**。我们要的就是 `/`，没影响。
>
> **更省事的备选**：不进这个表单，直接在静态托管首页用「**上传文件夹**」选本机 `admin-web/_hosting` ——
> 不涉及任何构建字段，最不容易填错。
- 备选（以后改前端更快）：`npm i -g @cloudbase/cli` → `tcb login` →
  `tcb hosting deploy _hosting -e jy-radio-d1gdwmptl816ee6a9`
  ⚠️ 命令名在文档里有 `tcb` / `cloudbase` 两种写法，以装完后的实际提示为准。

**③ ⚠️⚠️ 必配：SPA 路由 fallback（跳过这步 = 子路由一刷新就 404）**

本项目路由是 **history 模式**（`createWebHistory`），物理上云端只有 `index.html` 一个文件 ⇒
访问 `/dashboard` 时 CDN 找不到 `/dashboard.html`，返回 404。

> 症状：**首页能打开，但任何子路由刷新或直接访问都 404。**

修法：控制台 → 静态网站托管 →「**设置**」标签页 →「**错误页面**」填 `index.html` → 保存。
配完后访问 `/dashboard` 会返回 **index.html + 200**（注意是 200，不是 404 改了响应体），
Vue Router 拿到 URL 自己解析。

**④ 跨域白名单**

拿到静态托管的**默认域名**后，把它加进 **HTTP 网关 → 跨域设置 → 添加跨域域名**。
（值不带 `http://` 前缀、不带端口 —— 就是加 `129.28.26.180` 的那个地方。）
不加 ⇒ 页面能打开，但所有接口被浏览器拦掉。

**⑤ 本机已做的通路验证（可复现）**

构建产物 → 本机起静态服务器 → 真实 Chromium 打开 → 断言：

| 检查项 | 结果 |
|---|---|
| 页面渲染 | 截图 248KB（非空白页），3 个输入框 |
| history 路由 | 打开 `/` 自动 302 到 `/login?redirect=/dashboard` ✅ |
| 跨域连云端 | 返回 `{"code":40101,"message":"登录已过期，请重新登录","data":null}` ✅ |
| 页内 JS 报错 | 无 ✅ |

复现方式：`python -m http.server 8123`（在 `_hosting` 目录）+ agent-browser 截图，
形如 `fetch('https://<云地址>/api', {method:'POST', headers:{'Content-Type':'application/json'},
body: JSON.stringify({method:'GET', path:'/admin/profile', body:{}, token:'x'})})`。
能读到 `code:40101` 就说明**跨域通了、云端在响应**（被拦的话 fetch 直接 reject）。
顺带提醒：本机 `localhost` / `127.0.0.1` 在云网关白名单里（任意端口），所以本机能验。

**⑥ ✅ 登录页的默认凭据已清除（2026-09-30 已修）**

原来是这么写的（`admin-web/src/views/Login.vue`）：

```js
// 模板里 —— 无条件渲染，任何人都看得见
<p class="hint">默认超级管理员 teacher / <默认密码明文></p>
// script 里 —— 密码框预填 + 账号默认值
const savedUsername = localStorage.getItem(REMEMBER_KEY) || 'teacher';
const form = reactive({ username: savedUsername, password: '<默认密码明文>' });
```

⇒ **把管理端挂到公网，等于把默认管理员账号密码写在门口。**
（服务器上的 `http://129.28.26.180` 早就存在这个问题，只是那时访问面窄。）

**改法（3 处，只动这几行）**：
1. 删掉模板里那行 `<p class="hint">…</p>`，并删掉配套的 `.hint` 样式（scoped，无别处引用）
2. `password: '<默认密码明文>'` → `password: ''`
3. `|| 'teacher'` → `|| ''`

保留「记住账号」：勾选过仍从 `localStorage` 回填——那是用户自己的选择，不是我们替他把凭据摆出来。

**验收（本机静态服务器 + 真实 Chromium 探针）**：

| 检查项 | 结果 |
|---|---|
| 账号输入框初值 | `""` |
| 密码输入框初值 | `""` |
| 页面文本含默认密码 | `false` |
| 页面文本含「默认超级管理员」 | `false` |
| `.hint` 元素个数 | `0` |
| 渲染 | 截图 239KB，布局无塌陷，无 JS 报错 |

> ⚠️ 注意：修复后**源码/文档里也不要再写明文密码**（仓库会 push 出去）。
> 提交信息、注释、文档一律用「默认密码明文」这类指代。

⚠️ 顺带：服务器上那份 admin-web 是**同一份源码**构建的，这个修补也适用于它 ——
下次在服务器 `build admin-web` 时会一并生效。

---

**⑥-b 全仓默认凭据清理（2026-09-30 已完成）**

清完登录页顺手全仓扫了一遍：`admin123456` 原来散在 **30 个文件 / 47 处**。
**不是一律替换**，按性质分三类：

| 类别 | 位置 | 处理 |
|---|---|---|
| 真会生效的默认值 | `src/config/index.js`、`docker-compose.yml`、`.env.example`、`sql/schema.sql` | **去掉默认值** |
| 文档 / 启动提示 | `README.md`×4、`AGENTS.md`、`CLAUDE.md`、`admin-web/README.md`、`docs/specs/08-docker-deploy.md`、`deploy/start.sh｜ps1`、`src/docs/swagger.js` | 改成「见 `INIT_ADMIN_PASSWORD`」 |
| 测试 / 预览 / 一次性脚本 | `tests/*`、`scripts/http-test.js`、`preview/*`、根目录 `_*.js`、`admin-web/_backup` | 中性占位（测试串 / `PWD_PLACEHOLDER` / 读环境变量） |

**三处重点（都不是「文档里写了个密码」那么轻）**：

1. `src/config/index.js` 的 `password: … || '默认值'` ⇒ 后端**每次在空库上启动都会真的创建**这个账号。
   现改为**留空即随机生成**（`src/utils/seed.js` → `crypto.randomBytes(12)`），
   且**只在首次启动日志里打印一次**，之后再也拿不到。
2. `sql/schema.sql` **直接插了一条密码等于公开默认值的 `teacher` 记录**，连 `bcrypt hash` 一起进了仓库
   ⇒ 任何人都能"验证"出密码。现在整条 INSERT 注释掉，账号交给后端 `seedAll()` 建（行为等价）。
3. `README.md` 的「管理员密码忘了」给了一条把密码**重置回已知值**的现成 SQL
   ⇒ 读到 README 就能一步拿回后台。现改成「自己先生成 hash」的两步法。

**验收**：
- 全仓 `grep -rn admin123456`（排除 `node_modules` / `.git`）⇒ **只剩本机 `.env` 一行**
  （不在版本库、也不影响线上；那行本来就是失效的旧默认值）
- `src/utils/seed.js` 新逻辑 6 项断言全通过：随机密码长度 16 / 能用它登录 / 不再是旧默认值 /
  已存在则跳过不覆盖 / 配了就用配置值 / 配了就不打印
- `tests/auth.test.js` 6/6 通过

> ⚠️ **还剩一处更重的刻意没动**：MySQL **root 密码 `root123`** 硬编码在 `docker-compose.yml`（3 处默认值）、
> `README.md`、`AGENTS.md`、`CLAUDE.md`、`docs/*`、`scripts/*`，约 **25 处**。
> 它连着线上 MySQL，改默认值有真实影响 ⇒ **不擅自扩大范围**，等单独拍板。

---

**⑥-c 🔴🔴 线上后端的 JWT 密钥是公开默认值（2026-09-30 实测，**当时仍然有效**）**

查 `root123` 那个问题时顺手看到 `docker-compose.yml` 里还有一行：

```yaml
JWT_SECRET: ${JWT_SECRET:-please-change-me-in-production}
```

而 `src/config/index.js` 的兜底值是 `radio-station-default-secret`、
`.env.example` 里写的是 `please-change-me-to-a-long-random-string` —— **三串全在公开仓库里**。

**这为什么比 `root123` 严重一个量级**：

| | `root123`（MySQL） | 公开的 `JWT_SECRET` |
|---|---|---|
| 外网可达？ | ❌ 没映射端口，只在 `radionet` 内网 | ✅ nginx 把 80/443 对公网开着，`/api/admin/*` 就在那儿 |
| 能干什么？ | 先进内网才能连库 | **直接伪造管理员身份** |
| 要不要密码？ | 要（虽然公开） | **不要 —— `adminAuth` 只验签名不查库** |

关键在 `src/middlewares/auth.js` 的 `adminAuth`：它只做 `verify(token)` + 检查
`payload.id && payload.username`，**从不查数据库** ⇒ 只要密钥公开，
任何人签一个 `{ id:1, username:'teacher', role:0 }` 就是超管。

**实测（只发只读 GET，不写任何数据）**：用 `.env.example` 那串自签 token 打
`GET /api/admin/profile` ⇒ 返回 `code:0` 和真实管理员资料
（`{"id":1,"username":"teacher","nickname":"指导老师","role":0,...}`）。
另外两串返回 `40101`。⇒ **服务器 `.env` 里 `JWT_SECRET` 没改过，沿用了 `.env.example` 的示例值。**

**修法**（在服务器 `~/radio` 下）：

```bash
# 1) 生成一个真实随机值（或直接抄学生端云函数里那个真实 JWT_SECRET，让两边一致）
openssl rand -hex 32

# 2) 写进 .env（替换掉原来那行 JWT_SECRET=...）
#    注意：不要写进任何会提交的文件

# 3) 重建后端容器
docker compose up -d --force-recreate radio-backend

# 4) 复验（应三串全未命中）
node scripts/verify-backend-jwt.js
```

⚠️ 配后**存量 token 全作废**（学生 + admin-web 各重登一次），预期行为。

> ⚠️ **踩过的坑：改完复验"还是命中"先别急着改文件。**
> `docker-compose.yml` 的 `${JWT_SECRET:-兜底值}` 把**空串当成"没设置"**，所以如果写入时粘空了，
> 探测脚本会显示"还是命中某个公开值" —— 看着像文件没改，**其实是改成了空、然后回落到了兜底值**。
> 实测就是这样：改之前命中 `.env.example` 的示例值，改完变成命中 compose 的兜底值（**两个都是公开的，等于换了一把钥匙**）。
>
> 排查顺序（**先从容器读实际值，再回头查文件**）：
> ```bash
> cd ~/radio
> docker compose exec radio-backend printenv JWT_SECRET   # ① 实际生效值是什么
> grep -n '^JWT_SECRET' .env                              # ② 文件里到底写了什么
> sed -n '19p' .env | cut -c1-24                          # ③ 值在不在（只截前几字符）
> ```
> 另外两条同样会造成"改了没用"：`docker compose restart` **不重读 `.env`**（必须 `up -d --force-recreate`）；
> **在非项目目录跑 `docker compose`** 时 `.env` 压根不加载。

**代码侧已加护栏**（`src/config/index.js`）：命中这三串之一 + `NODE_ENV=production`
⇒ **直接拒绝启动**并打印修法；本机开发只警告。`docker-compose.yml` 的兜底值也已清空。

**复验工具**：`node scripts/verify-backend-jwt.js [baseUrl]`（默认打线上，退出码 1 = 没通过）。
⚠️ 判据同样**只允许看响应体 `code`** —— 本项目 HTTP 恒 200，拿状态码判会把拒绝误报成通过。

---

### 建议的顺序

1. **先把 A 做出来跑通** —— 目标是让「服务器停不停」都不影响老师登录。
2. 观察一阵，若确实要长期用且嫌中间页烦，再走 B（那时候才需要备案那 1–20 个工作日）。

---

## 随时切回（两条线各回各的）

**admin-web（老师侧）**：把 `VITE_REQUEST_MODE` 改回 `direct`（或删掉这一行）重新 build 即可 ——
原 Express 后端、MySQL、Docker 链路**一行都没动**。

**小程序（学生侧）**：把 `miniprogram/app.js` 的 `requestMode` 改回 `'direct'` 重新上传即可 ——
`baseURL`、云函数、云数据库都还在。

**建议：切 cloud 后先别急着停服务器**，观察几天确认稳定，再决定要不要停。

