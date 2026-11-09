# 云开发细则（`cloud/` 阶段 0–9）

> 从 `MEMORY.md` 拆出来的，主文件只留最要命那几条。

## 云开发（`cloud/` 阶段 0–9）
源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。⚠️ Windows CLI 传子目录必坏 ⇒ 打**单文件**，`handlers/index.js` **静态注册表**。
部署 `node cloud/scripts/deploy-cloud.js` → 手动 cli.bat → 等 1~2 分钟。
口径：业务查询用数字 `id`；4 张表业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段驼峰；`insertOne` 后改这行用返回的 `_id`。
- ⚠️⚠️⚠️ **新增集合 = 必须配自愈，否则上线第一下就是 50001**：云开发查**没建过**的集合是**抛错**
  （`-502005 database collection not exists`），**不是返回空数组**。2026-11-07 社团密钥就这么炸的：
  `try { createCollection } catch {}` 把失败吞了，紧接着的裸查询原样抛上去 ⇒ 陛下看到「服务器繁忙…（…-502005…）」。
  正解：`lib/db.js#ensureCollections`（幂等、每实例一次、失败不抛）进路径先建 + 读操作套 `readOr` 当空表；
  **假库用 `H.dropCollection(name)` 真删表才测得出**（默认假库对任何名字都返回空）。
- ⚠️⚠️ 切云弄坏上传类接口（信封 JSON ⇒ `FormData` 变 `{}`，40001）：契约 `{filename,fileBase64}`，凡 FormData/Blob 切云后必须单验。
- ⚠️⚠️ **上传两道硬上限都跟 base64 有关**：① HTTP 访问服务请求体 ≈100KB（base64 再 +33%）⇒ 名册导入大表 413；
  ② **小程序 `callFunction` 的 data 只有 ≈1MB**（不是"不受限"）⇒ 手机直出照片 2~5MB、base64 后 3~7MB，
  平台侧直接回 `data exceed max`，**请求根本到不了云函数**（2026-11-07 换社团头像真机就是这么卡的，服务端那句「超过 2MB」永远触发不到）。
  凡上传类接口，**第一步是在客户端压**（头像压到 720px / base64 ≤700KB），服务端尺寸判断只当兜底。
- ⚠️⚠️ 学生初始密码＝`user`+学号（唯一出口 `studentAccountService.initPasswordFor()`；初始 cost 8、改密后 10）；管理端 DTO 字段是 `activated`。
- ⚠️⚠️⚠️ **名册逻辑有三份副本，改一处不算改完**：① `src/services/studentRosterService.js`（直连）
  ② **`cloud/cloudfunctions/api/services/roster.js`（云端副本＝线上真正跑的）** ③ `miniprogram/cloudfunctions/api/index.js`（`sync.js` 产物，`--check` 校验）。
  只改 `src/` ⇒ 切云不生效；改完不 `sync.js` ⇒ 部署的还是旧产物。**"改完没生效"先问改的哪一份、打包了没。**
- 云端唯一性**不是索引**，是 `unique_keys` 集合（`lib/db.js:170` `reserveUnique` → `_id="scope:key"`）；运行时只用 `user_name` scope。
- ⚠️ `cloudfunctions/api/index.js` 是**产物**，别手改。

