# 真机收尾清单（阶段 9 之后 · 一次性）

> 目标：把「服务器 Express + MySQL」整体切到「云开发 + 云数据库 + HTTP 访问服务」。
> 原则：**原链路一行不删、随时可切回**（admin-web 只改一个环境变量）。
> 现状：阶段 0–9 的代码 / 断言 / 文档全完成；本机回归 **3115 项 / 0 失败**。
> 相关：迁移三步的细节见 `cloud/migration/README.md`；通道选型见 `stage9-admin-web-plan.md`。

---

## 为什么要你手动做这三类事

| 类别 | 卡点 |
|---|---|
| 部署云函数 | 本机沙箱把 **`reg.exe` 列入程序黑名单**（安全中心 → 命令安全），CLI 初始化即被拦。**服务端口本身是开的**（`enableServicePort: true`），换到你自己的终端跑就正常 |
| 控制台操作 | 配触发路径 / 导入 / 导出 —— 只有控制台能点 |
| 导出生产库 | 本机 `.env` 是 **sqlite**（`DB_DIALECT=sqlite`、`DB_STORAGE=./data/radio.db`），连不到服务器 MySQL |

---

## ① 配 HTTP 访问服务（云开发控制台）

1. 打开云开发控制台 → 选环境 `jy-radio-d1gdwmptl816ee6a9`
2. 左侧 **HTTP 访问服务** → **添加路径**
3. 路径填 `/api`，指向云函数 **`api`**，保存
4. 记下**默认域名**，形如 `https://jy-radio-d1gdwmptl816ee6a9.service.tcloudbase.com`

- ⚠️ **不需要备案** —— 腾讯云自己的域名已备案。只有你想绑**自有域名**时才要备案。
- ⚠️ 默认域名**有有效期**，到期控制台点「**续期**」。失效表现是全站突然 404/502，最难查。
- ✅ 判据：浏览器访问 `https://<默认域名>/api/health` 能返回 JSON（不是控制台 404 页）。

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

容器里 `WORKDIR /app`、`COPY . .`，且 DB_* 由 compose 注入 —— 所以**直接在容器内跑最省事**（服务器不用装 node）：

```bash
cd ~/radio
git pull                                              # 拿到 cloud/migration/
docker compose build radio-backend                    # 让新代码进镜像
docker exec -i radio-backend node cloud/migration/export.js
docker cp radio-backend:/app/cloud/migration/out ./cloud/migration/out
```

再把 `cloud/migration/out/` 整个目录拷回本机（或用 scp）。

- ⚠️ 结尾若打印 `error N 条`，**那些行没有导出** —— 先看 `out/_report.json` 处理掉再继续。
- ✅ 判据：`out/` 里有 16 个 `<collection>.jsonl` + `unique_keys.jsonl` + `sequence.jsonl` + `_snapshot.json`。

## ④ 导入云数据库（控制台）

控制台 → 数据库 → 逐集合「导入」→ 选对应 `.jsonl` → 冲突处理选 **Upsert**。

需要导入 **18 个集合** = 16 张业务表 + `unique_keys` + `sequence`。

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

`admin-web/.env.local` 已经建好骨架，改两行即可：

```ini
VITE_REQUEST_MODE=cloud
VITE_CLOUD_API_URL=https://jy-radio-d1gdwmptl816ee6a9.service.tcloudbase.com/api
```

然后：

```bash
cd admin-web && npm run build
```

✅ 判据：能正常登录、投稿列表能加载、导出 xlsx 能下载。

---

## 随时切回

把 `VITE_REQUEST_MODE` 改回 `direct`（或删掉这一行）重新 build 即可 ——
原 Express 后端、MySQL、Docker 链路**一行都没动**。

**建议：切 cloud 后先别急着停服务器**，观察几天确认稳定，再决定要不要停。
