# 伙伴端小程序登录 v55 实施

1. 重写原生伙伴登录的 WXML/WXSS 为通栏园林、顶部返回与标题、品牌、浅色悬浮表单。保留 username/password/showPwd/loading/loginError 及原有登录处理，只加帮助交互及必要文案修正；JSON 允许原生页面纵向滚动。复用 /assets/me-bg.jpg 与 station-badge.png，不改 app.json、app.js、学生页面或后端。
2. 重写 preview/partner-hub-codex-v2/login.html 为现有 portal-shell.css 的手机壳，手机内部单列登录；新增或重写 login.css 只包含登录与外部预览布局，彻底删除桌面产品分栏。保留表单 ID 便于沿用验证。壳外演示身份按钮填入虚构账号，壳内保留伙伴账号、密码、帮助和登录；旧 demo-toggle/demo-accounts/back-workspace 改置于壳外。login.js 保留 QA 白名单、凭据解析和 setRole，不引入原生页的真实凭据。
3. 两端采用同一信息顺序和近似比例：顶部风景约 320px，品牌约 34px，表单卡从约 270px 开始；原生尺寸用 rpx 对应，导航区额外让出 statusBarHeight。输入框高约 50px，按钮 52px，触区至少 44px。图像使用 image/aspectFill，浏览器使用背景 cover；不靠浏览器断点改变产品布局。CSS 所有作用域限于此独立登录预览。
4. 原生用 mock Page/wx/getApp 验证既有登录流程及新增帮助，无真实账号登录；WXML 事件逐项核对，JS/JSON/WXSS 语法检查。浏览器在原标签确认手机壳、320px、正常窗口、帮助和演示跳转，保留当前资料，保存截图。微信开发者工具若可用则进行编译检查；若只完成静态／模拟校验，最终如实说明。

沿用此前单轮独立文档审查；用户明确纠正并要求完成，直接落实修正，不重复询问方向审批。

完成验收：两份文档独立审查无 critical／major。原生伙伴登录四文件已修改，继续使用 adminLogin，未改 app.js、学生登录、后端或现有图像资源。新增 scripts/verify-partner-login-ui.js 的 20 项通过，JS 语法及 JSON／WXSS 解析通过，微信开发者工具自带 wcc.exe 和 wcsc.exe 对修改页面的编译均通过。没有提交真实账号、上传小程序或执行真机登录。

浏览器登录预览已彻底去除桌面产品分栏，正常窗口为约 390×852 手机壳，微信顶部胶囊与状态栏可见；演示身份选择、返回工作台预览与 Codex 署名均在壳外。原演示 20 项通过；真实浏览器验证空账号提示及帮助展开收回，320px 视口下整页宽 320px、手机内部宽 291px 且无水平溢出。最终恢复正常视口，保留当前登录预览；截图 shots/mini-login-v55.png。真实原生运行的视觉最终仍需微信模拟器／真机核对，此轮已完成原生页面编译与模拟业务校验。
