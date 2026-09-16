# 菁悠广播站小程序

> 对接 `radio-backend` 后端的微信小程序前端，原生 WXML/WXSS/JS 编写。

## 页面构成

| 页面 | 路径 | 功能 |
|---|---|---|
| 首页 | `pages/index` | 正在直播 / 本周节目单 / 公告 |
| 投稿 | `pages/submit` | 点歌 + 文稿（切换 tab） |
| 我的投稿 | `pages/mySubmit` | 我的记录 / 状态筛选 / 撤销 |
| 广播站介绍 | `pages/about` | 介绍、开播时间、联系方式 |
| 公告详情 | `pages/noticeDetail` | 公告正文 |
| 节目详情 | `pages/programDetail` | 节目信息 + 留言 |
| 登录 | `pages/login` | 微信一键登录（占位） |

## 配置后端地址

打开 `app.js`，修改 `globalData.baseURL`：

```js
baseURL: 'https://your-api-domain.com/api'
```

> 注意：小程序要求后端 HTTPS 且 ICP 备案。开发期可在微信开发者工具勾选"不校验合法域名"。

## 在微信开发者工具中打开

1. 微信开发者工具 → 导入项目
2. 目录选择 `miniprogram/`
3. AppID 选择"测试号"或填自己的
4. 项目名称：radio-station

## 隐私合规

- **仅获取微信昵称/头像**，不收集手机号
- 所有投稿/留言均经人工审核后才展示
- 公告/介绍由管理端 KV 配置
