# 菁悠广播站管理后台

> Vue 3 + Vite + Element Plus 单页应用，对接 `radio-backend` 后端。
> 默认账号：**teacher / admin123456**

## 启动

```bash
# 安装依赖
npm install

# 开发模式（默认代理到 http://localhost:3000）
npm run dev

# 生产构建
npm run build
```

构建产物在 `dist/`，可直接放到任意静态服务器（Nginx、云开发静态托管、对象存储+CDN）。

## 页面

| 路由 | 文件 | 功能 |
|---|---|---|
| `/login` | `views/Login.vue` | 管理员登录 |
| `/dashboard` | `views/Dashboard.vue` | 数据概览 + 7 天趋势图 + Top10 |
| `/submit` | `views/SubmitList.vue` | 投稿列表、详情、通过/驳回/批量/删除 |
| `/program` | `views/Program.vue` | 节目 CRUD + 直播开关 |
| `/notice` | `views/Notice.vue` | 公告 CRUD + 上下架 |
| `/message` | `views/Message.vue` | 留言审核 |
| `/account` | `views/Account.vue` | 管理员账号管理（仅超管） |
| `/setting` | `views/Setting.vue` | 系统 KV 设置（仅超管） |

## 切换后端地址

修改 `.env.development`（开发）或 `.env.production`（生产）：

```env
VITE_API_BASE=/api
VITE_API_PROXY_TARGET=http://localhost:3000  # 仅 dev 有效
```

生产部署时建议直接走 Nginx 反代，把 `/api` 反向代理到 Node 后端，前端代码无需修改。

## 路由权限

- 路由守卫基于 Pinia `auth` store
- 未登录 → 重定向 `/login?redirect=...`
- 非超管访问 `superAdmin: true` 路由 → 重定向 `/dashboard`
