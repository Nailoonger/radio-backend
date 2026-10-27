# 伙伴端登录页 v54 实施

历史记录：此版桌面产品布局作废，当前实施及验收见 ../login-v55/plan.md。

在 preview/partner-hub-codex-v2 下新增 login.html、login.css、login.js，不引入新构建依赖。login.html 使用语义化 form、label、aria-describedby、autocomplete=username/current-password；背景直接引用 assets/profile-campus-garden.png。背景图作为独立装饰层，手机端高度约 370px、焦点在凉亭位置；登录面板宽度随手机自适应且在图上叠放，桌面断点 760px 后改为右侧居中面板。短屏不固定内容高度，支持自然纵向滚动。

login.js 用 UMD 形式导出纯凭据解析和 enterDemo 方法，浏览器端监听表单／显隐／演示折叠／帮助。演示账号固定映射到现有 member、manager、super；使用同一示例密码 demo123456，页面明确为演示。登录只调用 CodexHubStore.setRole，成功后进入同目录 index.html 的 home／manager，不从 URL 接受重定向目的地，不存储输入。错误文本通过 textContent 输出。提交期间防重复提交，失败恢复按钮；不使用人为网络延迟。

<!-- review-fix: LOGIN-P1 -->
原 index.html 外侧 control-links 增加登录链接，不加入主底部导航，不改现有工作区路由。工作区进入登录、登录返回工作区以及成功跳转，均仅白名单透传 qa=1，保持 store 数据键一致，不透传任意 return URL。新页面提供返回现有工作台的文字链接。用真实行为测试验证凭据映射、空值／错误、setRole 失败、QA 同键往返及原业务资料保留；JS 语法和 CSS 解析通过后启动现有 8769 静态服务。浏览器验证手机和桌面布局、表单交互，截取登录页并留下可用预览。继续完成上一轮超管撤回的末轮校验，避免遗留半成品。

单轮独立审查：spec 无问题；plan 发现数据空间参数保留问题 1 项，按 LOGIN-P1 修正，未消化 critical／major 为 0，沿用用户“继续”的实现授权自动推进。

完成验收：独立验证 verify-login.js 20 项、原父导航 67 项、手机外壳 60 项，共 147 项通过，相关 JS 语法与 CSS 解析通过。浏览器验证空账号、错误凭据、密码显隐、演示账号填入、超管成功登录与 QA 同键跳转；返回链接按原 QA 数据空间保留。320px 与 391px 实际 CSS 宽度无横向溢出，手机背景保留凉亭、桥与水池。桌面使用同一原图，登录浮层独立布局。浏览器没有清空业务资料，演示身份检查后恢复社干；未接真实账号接口。最终截图保存在 shots/partner-login-v54-mobile.png，预览标签保留。
