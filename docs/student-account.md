# 学生账号体系（导入分发 + 账号密码登录）

> 状态：后端已实现并通过验证（2026-09-18）。方案稿在 `preview/student-account-v1/`。
> 小程序登录页与管理端页面**尚未动**（界面按约定需先出静态预览）。

## 1. 规则

| 项 | 规则 |
|---|---|
| 账号 | 入学年级(4) + 班级(2) + 序号(2)，如 `20240101` |
| 初始密码 | `user+学号`（全员统一，首次登录后可改） |
| 范围 | 班级 01~99、序号 01~99；超出该行报错，不导入 |
| 唯一性 | `username` 全局唯一 + `UNIQUE(grade, class_no, seat_no)` 双保险 |
| 姓名 | 可选列，存 `remark`（不参与账号生成） |
| ⚠️ 不含学期 | 学生转班要管理员手工改；**改账号时会同步迁移他的投稿 / 留言 / 已确认记录**，避免「我的投稿」变空 |

## 2. 数据模型

复用 `user` 表（不新建身份表）——这样 `submit` / `message` / `notice_ack` 全部按 `openid`
字段关联的存量逻辑**一行都不用改**。

新增列：`username` `password` `grade` `class_no` `seat_no` `remark` `status` `pwd_changed_at`
`last_login_at` `login_count` `import_batch_id`；`openid` 改为**允许 NULL**。

新增表 `import_batch`（导入批次）：支持「传错表格一键撤销」，只删本批次中未激活且无投稿记录的账号。

索引：`uk_username`、`uk_grade_class_seat`、`idx_grade_class`。

**迁移（已有库必须手动跑）**：

```powershell
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-student-account.sql
```

> `sql/schema.sql` 只在数据卷首次启动时执行，**对现有库无效**。

## 3. 兼容设计（三个关键取舍）

1. **JWT 的 `openid` 字段填「账号本身」**，并额外带 `uid` / `username` / `pv`。
   → 存量所有 `req.user.openid` 的用法零改动；老微信 openid（wx 开头的长串）与 8 位账号天然不撞车。
2. **新增登录接口而不是改造 `/user/login`**：新增 `/user/login/account`，原微信登录保留。
   真正强制靠开关 `account_login_required`（默认 on，缺行即视为 on）——
   光改小程序页面不算强制，旧版小程序直接调接口也得在这里被拦住。
   ⚠️ 测试环境（`NODE_ENV=test`）放行微信登录，否则既有 56 条用例里拿 token 的链路全断。
3. **`user` 模型加了 `defaultScope` 排除 `password`**；只有登录 / 改密显式用 `User.scope('withPassword')`。

## 4. 接口

用户端：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/user/login/account` | `{username, password}` → `{token, user}`；`user.isDefaultPwd` 标记是否仍是初始密码 |
| PUT | `/api/user/change-password` | `{oldPassword, newPassword}` → 新 token；新密码 ≥8 位且含字母 + 数字 |
| GET | `/api/user/me` | 老字段不变，账号用户多返回年级 / 班级 / 序号 / `isDefaultPwd` |
| POST | `/api/user/login` | 保留；开关打开时返回 `40302` |

管理端（全部 `requireSuperAdmin`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/student/import/preview` | multipart `file`，**只解析不落库**，返回逐行结论 + `rawRows` |
| POST | `/student/import/commit` | `{rows, filename, force?, strict?}`，服务端**重新解析 + 重新校验** |
| GET | `/student/template` | 模板 xlsx（含「填写说明」第二页） |
| GET | `/student/list` | 关键字 / 年级 / 班级 / 状态 / `activated` / 批次 + 分页 |
| GET | `/student/stats` | 按年级班级汇总：总数 / 已激活 / 未激活 |
| GET | `/student/grades` | **按年级汇总**：每届 总数 / 已激活 / 未激活 / 停用 / 班级数 |
| GET | `/student/grade/:grade` | **该届明细 + 清理试算**（只读）：`canDelete` / `withSubmit` / 班级分布 |
| DELETE | `/student/grade/:grade` | **整届清理**：`{mode?: safe\|disable\|purge, confirm?}` |
| GET | `/student/export` | 导出 xlsx（含初始密码，已改密的行留空） |
| PUT | `/student/:id` | 改姓名 / 三元组 / 状态（改账号会迁移投稿归属） |
| PUT | `/student/:id/status` | 启用 / 停用 |
| PUT | `/student/:id/reset-password` | 重置为 `user+学号` |
| POST | `/student/reset-password/batch` | 批量重置（必须给 `ids` 或 `grade`/`classNo`，否则拒） |
| DELETE | `/student/:id` | 有投稿记录时改为停用，不硬删 |
| GET | `/student/batches`、POST `/student/batch/:id/rollback` | 批次列表与撤销 |

⚠️ **路由顺序**：凡含字面量段的路径（`import` / `template` / `list` / `stats` / `export` /
`batches` / `reset-password`）必须注册在 `/student/:id` **之前**，验证脚本里有断言守着。

### ⚠️ 姓名的字段名（2026-09-21 踩坑修）

改姓名走 `PUT /student/:id`，**对外字段名是 `name`**（`toDto` 里也叫 `name`）：

```json
{ "name": "张三丰" }
```

服务端拿到后**必须同时写 `remark` 和 `nickname` 两列**，因为读的地方不是一个：

| 读哪 | 读的列 |
|---|---|
| 管理端学生账号列表 | `remark`（`toDto` → `name`） |
| 管理端投稿审核 / 留言审核 | `nickname \|\| remark`（nickname 优先） |
| 小程序「我的」页 / `/user/me` | `nickname \|\| remark` |
| 名册导入落库 | 两列一起写（`patch.remark = r.name` + `patch.nickname = r.name`） |

- 兼容：`remark` / `nickname` 也当别名接受，避免调用方传错 key 却**静默什么都不改**（曾经
  管理端发 `{remark, nickname}`、后端只认 `payload.name` → 接口回 200「已保存」，姓名一个字没动）。
- 校验：空白名 → `40001`；超过 64 字 → `40001`。
- 回归：`scripts/verify-student-account.js` 的 **G3 段**（12 项断言）守着这条链路，
  含「学生端 `/user/me` 也要看到新名」——只写 `remark` 会在这里变红。

## 5. 导入识别规则（三段确定性规则）

1. **认表头**：扫前 3 行找关键词（入学年份 / 年级 / 届 / 班级 / 班 / 序号 / 座号 / 编号 / 学号 / 姓名）；
   纯数字单元格永不当表头。命中最多的一行当表头行。
   一个都没命中 → 按列序取第 1/2/3 列，并把第 4 列当姓名。
2. **逐格归一化**：`2024级` / `2024届` / `24` / `２４`(全角) / `'2024`(撇号) → `2024`；
   `1` / `1班` / `高一(1)班` → `01`；`5号` / `第5` → `05`。
   支持整列合并写法：`20240101` / `2024-01-01` / `2024 01 01` / `2024级1班1号`
   （兜底逻辑：三元组没凑齐时，拿本行第一个能切出三段的单元格再试）。
3. **逐行出结论**：`new` 新建 / `update` 覆盖（未激活）/ `active` 已激活受保护 / `invalid` 异常（带真实行号 + 原因）。

已用**用户提供的真实名册**（4 列含姓名、右侧空列、尾部 3 个空行）验证：
正确识别表头、跳过空行、7 行全对（`20240101` `20240202` `20240322` `20240433` `20240745` `20241054` `20241332`）。

## 6. 必须记住的性能 / 安全 / 机制点

1. **初始密码只 hash 一次，整批复用同一个哈希串。**
   bcrypt 每行 60~100ms，导入 2000 人若逐行 hash 就是 2~3 分钟 → 接口必然超时。
2. **JWT 无状态 → 禁用 / 重置密码后旧 token 还能活 7 天。**
   鉴权中间件加了「账号状态 30 秒缓存 + `pv`（密码版本）比对」：
   - 改密 → `pwd_changed_at` 变 → 旧 token 401
   - 管理员重置 → `pwd_changed_at` 归零 → 旧 token 401
   - 停用账号 → 30 秒内被踢下线
   模式照搬 `switchService` 的 30 秒内存缓存，不给数据库加压力。
3. **头像机制（2026-09-18 定死）：全站头像一律「姓名首字圆形」（姓作图），用户不允许更换。**
   - 服务端是真正的强制点：`/user/login` 对客户端传来的 `avatar` **直接丢弃**（不落库、不更新），
     老版本小程序带着这个字段调用也不会报错；库里 `user.avatar` 恒为空串。
   - 小程序端 `mySubmit`（我的页）**删掉了头像 image 分支**，永远渲染 `nicknameInitial`（姓名首字），
     没有任何上传入口；登录页 / 我的页文案改为「不收集头像与手机号，头像由姓名生成」。
   - 学号账号的昵称 = 名册姓名，是权威数据，客户端也改不了（账号登录接口根本不收昵称）。
   - 风采展示（cadre / staff）的照片是管理员在后台传的素材图，不属于用户头像体系，不受影响。

## 6.5 按年级管理与一键毕业清理（2026-09-18 增量）

- 账号前 4 位就是入学年份，`user` 表已有 `idx_grade_class` 索引 → **按年级查询不加表**，
  `GET /student/list?grade=2024`、`GET /student/export?grade=2024` 一直就支持。
- 新增 3 个接口（见 §4）：`grades`（年级汇总）、`grade/:grade`（明细 + 清理试算，只读）、
  `DELETE grade/:grade`（整届清理，三种模式）。
- **清理三模式**：`safe`（默认，无投稿真删 / 有投稿改停用 —— 与单个删除同规则）、
  `disable`（只停用不删）、`purge`（全删，**必须把年级原样填进 confirm** 才放行）。
- **执行后登录态立即作废**：被删 / 被停用的账号逐个 `accountService.invalidate()`，不等 30 秒缓存。
- 界面：`preview/admin-ui-v8/`（6 屏：方案说明 / 按年级总览 / 年级详情 / 清理确认 / purge 危险确认 / 清理完成）。

## 7. 验证与回归

```powershell
node scripts/verify-student-account.js     # 124 项断言，SQLite 内存库，不需要 MySQL
npx jest                                   # 既有 56 条用例
```

验证脚本结果写在 `scripts/verify-student-output.txt`。

### ⚠️ 既有测试的失败基线（别误判成自己改坏了）

`npx jest` 当前 **26 条失败，全部与本次改动无关**（都是工作区里更早的未提交改动导致的，
测试文件没跟着更新）：

| 数量 | 用例 | 真实原因 |
|---|---|---|
| 16 | `member.test.js` + `switch.test.js` 的 member 部分 | `member` 路由已随 cadre + staff 迁移删除，只剩注释，接口返回 40401 |
| 10 | `submit.test.js` | 投稿现在要求「点歌注意事项已确认 + 播出时段必须来自 `/submit/timeslots`」，老用例裸投 → 40001 |

本次改动**新增失败 0 条**（为此专门调整了两处设计：`account_login_required` 不写进 seed，
改由 `switchService.KNOWN_SWITCHES` 在管理端列表补默认行 —— 否则会顶掉
`switch.test.js` 里「seed 恰好 4 条开关」的断言）。

**建议下一轮**把那 26 条用例按现状修掉（member 相关可删除），否则回归信号一直是红的。

## 8. 已确认的决策（2026-09-18 用户拍板）

| # | 问题 | 决定 | 实现状态 |
|---|---|---|---|
| 1 | 门禁范围 | **B：只拦「投稿 / 点歌、留言、我的」**；首页、节目单、公告、风采免登录 | 后端零改动（这些接口本来就是登录保护的）；小程序端「未登录不跳空白页，盖弹层引导登录，回来回到原页」待做 |
| 2 | 首次登录是否强制改密 | **A：只提示，可跳过** | 已实现（`isDefaultPwd` 标记 + 前端引导；「暂不修改」后「我的」页留黄色提醒 + 入口带「待修改」标签） |
| 3 | 序号缺失 / 重复 | **A：报错不导入，回去改表** | 已实现（异常行带真实行号 + 原因，不写库） |
| 4 | 已激活账号被再次导入 | **A：跳过保护，要覆盖得显式勾选** | 已实现（默认 `force=false` 跳过；勾选后覆盖但**不碰密码**） |
| 5 | 微信一键登录 | **A：保留接口但默认关闭** | 已实现（`account_login_required` 默认 on，关掉即回退） |

> ⚠️ 因为选了 ①B，**不做冷启动全站拦截**：首页/节目单/公告/风采照旧免登录可看，
> 只在「投稿（含点歌）、节目留言、我的」三个入口挂 `guardLogin()`。

界面预览：`preview/student-login-v1/`（7 屏：登录页默认/错误态、被拦弹层、首页免登录对比、
「我的」页、修改密码页、首次登录引导）。

## 9. 下一步

1. 小程序登录页改账号密码表单（**先出静态预览 v1 待确认**）+ 冷启动门禁 + 401 兜底 + 改密页
2. 管理端新增「学生账号」页面（导入 / 预览 / 列表 / 导出 / 重置；**先出静态预览**）
3. 用真实名册灰度导入一个班 → 导出核对 → 再全量
