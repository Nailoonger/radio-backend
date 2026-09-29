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

> 🐞 **发现一个显示瑕疵（已报告，待陛下裁决）**：`Dashboard.vue:170`
> `const baseURL = import.meta.env.VITE_API_BASE` ⇒ 系统信息卡「后端地址」恒显示 `/api`（direct 模式的地址）。
> cloud 模式下实际请求发往云域名，卡片仍显示 `/api`，**是误导**。
> 改法（一行）：`import { requestMode, cloudApiUrl } from '@/utils/http'` →
> 显示 `requestMode === 'cloud' ? cloudApiUrl : import.meta.env.VITE_API_BASE`。

> ⚠️ **两件必须知道的事**（本次实测挖出来的）：

1. **云函数的 CORS 白名单含 `localhost`（任意端口），不含服务器 IP。**
   实测 `Origin: http://localhost:5173` / `:8080` → 回 `access-control-allow-origin`；
   `Origin: http://129.28.26.180` / `https://example.com` → **不回 CORS 头**。
   ⇒ 本机 `npm run dev` **不用配跨域**就能调云端；
   **正式上线时必须去控制台「跨域设置」加 admin-web 的真实域名**，否则浏览器会拦。

2. **云函数没有配 `JWT_SECRET`，正在用代码里的兜底值。**
   实测：用兜底密钥 `radio-station-default-secret` 自签的 token 能通过云端校验并取到数据
   ⇒ `process.env.JWT_SECRET` 为空。
   - 影响一（功能）：本次登录签发的 token 都挂在兜底密钥上，**之后一旦补配 `JWT_SECRET`，
     这些 token 全部失效**，管理人员/学生要重新登录一次。**要配就趁现在配。**
   - 影响二（安全）：兜底值写死在仓库里，拿到代码的人能**伪造超管 token**。
   - 建议：控制台 → 云函数 `api` → 配置 → 环境变量，加
     `JWT_SECRET` = 原服务器 `.env` 里的同一个值（`grep JWT_SECRET ~/radio/.env`）。
     用同一个值的好处：服务器时代没到期的 token 继续有效，学生不用重新登录。

### 上线方式（三选一，待定）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A 服务器继续托管** | 在服务器 `~/radio/admin-web/.env.local` 放同两行（`admin-web/.dockerignore` 没排 `.env.local`，且 compose 的 build context 就是 `./admin-web`，容器内 `npm run build` **读得到**）→ `docker compose build admin-web && up -d` | 一条命令搞定；但文件未跟踪，重新 clone 会丢。**仍需配控制台跨域**（服务器 IP 不在白名单） |
| **B 云开发静态托管** | 本机 build → 上传 `dist/` | 最贴合「不续费服务器」；要 CLI 登录 + 配跨域 |
| **C 服务器 nginx 反代 `/api`** | 在 `admin-web/deploy/nginx-admin.conf` 加一条 `location /api { proxy_pass <云域名>/api; }`，`VITE_CLOUD_API_URL` 写相对路径 `/api` | **永久免 CORS**；但服务器摘不掉 |

> 现在**不必马上决定**：本机 `npm run dev` 已经能完整验功能。等确认稳定再选上线方式。

---

## 随时切回

把 `VITE_REQUEST_MODE` 改回 `direct`（或删掉这一行）重新 build 即可 ——
原 Express 后端、MySQL、Docker 链路**一行都没动**。

**建议：切 cloud 后先别急着停服务器**，观察几天确认稳定，再决定要不要停。
