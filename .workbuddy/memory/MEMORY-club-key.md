# 社团密钥 / 社团提报（2026-11-07 落地）

> 从 `MEMORY.md` 拆出来的，主文件只留最要命那几条。

## 社团密钥 / 社团提报（2026-11-07 落地）
`services/clubKey.js`（6 位密钥，**只存 sha256 哈希 + 掩码**，明文只在 `POST /partner/club-keys/:id/reset` 响应出现一次）+
`services/clubNotice.js`（状态机 0 待审 / 1 待播 / 2 驳回 / 3 已播 / 9 撤回）。
- 为什么 sha256 不用 bcrypt：学生输码时服务端**不知道是哪个社团**，bcrypt 要全表逐比（N×25ms），sha256 直接等值查一条。
- ⚠️ **作废必须清 `key_hash`**，只改 status 是假作废（列表显示已作废、旧钥匙照样能进）。
- 学生凭票据（48 hex，`SESSION_TTL_MS=2h`，库里只存 `ticket_hash`）；**重置不踢已发票据**（重置是给新人，不是赶在校生）。
- ⚠️⚠️ **整条线不要求学生登录**（2026-11-07 陛下当面纠正）：`verify/me/avatar` 与提报 5 个接口一律没有 `requireUser`，
  唯一凭证是票据。试错闸按 `ctx.source`（openid/IP）限速，**不按登录用户**。落款 `optionalUser()`：有 token 用学号，没有退「社长」。
- ⚠️ 票据失效报 **40102** 不是 40101 —— `utils/request.js` 见 40101 会清学生登录态，两小时一次过期就把人踢下线。前端判断写 `40102 || 40101`。
- ⚠️ 试错闸必须**落库**（`club_key_tries`，一份来源一文档，只存 `{minute,count}`）：云函数无状态，内存计数等于没有。
- ⚠️ 种子用业务键 `_id='club:<社团名>'`（自动 `_id` 挡不住并发 ⇒ 轮播出现两个「电视台」）。
- ⚠️ 并发控制靠条件更新 `updateWhere({_id, status: ST.WAIT}, patch)`，0 行 ⇒ 40901「这条已经处理过了」。
- ⚠️ 权限位第 4 个 `clubkey`；**加 PERM_KEYS 必须同步加 PERM_ALL**（曾 undefined ⇒ `!!undefined === false`）。
- ⚠️ `utils/clubTime.js` 不能用 `utils/format.js#fmtIso`：那条取字符串墙钟字段（给 `+08:00`），本线单据是 `toISOString()`，会差 8 小时且看着正常。
- ⚠️ 图片处理抽到 `lib/image.js`（`admin/upload.js` 与学生端头像共用一份 mime 判据）。
- 头像：`PUT /user/club-key/avatar`；存 **720×720 方图** JPEG 0.86（约 80~150KB），圆由各处自己削。

