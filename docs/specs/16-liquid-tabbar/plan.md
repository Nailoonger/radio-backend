# 小程序底部导航水滴动效 Plan

## 架构概览
保留目标页播放动画的 v9 契约。点按立即记录来源并切页，目标页 setSelected 消费来源，渲染起点后开始 400ms 动画。胶囊采用动态生成的 wx.createAnimation 分段动画，位置和宽度共同表达两端运动，不引入逐帧计时器。

## 核心数据与接口
- tabFrom：已有全局一次性来源索引；仅有效整数 0～3 可作为来源。
- setSelected(index)：返回方向 -1、0、1，页面以返回值启动内容动画。每次调用递增本实例版本号，渲染回调只允许最新版本执行。
- indicatorAnimation：胶囊 left、width、scaleY 的动画导出数据；容器内部建立与四个 Tab 相同的四等分定位空间。
- motionClass：图标动画开关；在起点渲染时清空，在完成回调中设置，保证复用页面也能重播。
<!-- review-fix: callback-ownership -->
- selected 始终保存真实目标，visualSelected 保存视觉来源和终点；组件 pageLifetimes.hide 使旧渲染回调失效。switchTab 请求递增全局编号，失败仅清理编号仍匹配本次请求的来源。
- 页面 tabMotion：通过共享工具在目标页清空动画类后，于渲染回调中设置左右入场类；版本号避免过期回调覆盖。

## 动画时序
胶囊总时长 400ms，分为 120、120、100、60ms 四段。第一段前沿推进至路程的 72%，后沿推进至 12%，高度压到 90%；第二段前沿到达终点，后沿推进至 80%，高度 94%；第三段恢复原宽，整体越过终点 0.035 格，高度 102%；第四段恢复终点和原高度。左右方向镜像，跨格按实际格数计算。最终位置严格归零到目标格。

图标 400ms：0% 原尺寸、22% 缩至 0.82、65% 弹至 1.08、100% 原尺寸。文字颜色与两层图标透明度用 400ms 过渡。页面内容从点击方向一侧偏移 20rpx、透明度 0.6，400ms 回到原位，使用 animation-fill-mode: both。页面固定导航和启动遮罩保持独立。

## 文件组织
- miniprogram/custom-tab-bar/index.js、index.wxml、index.wxss：分段胶囊与图标动画，更新契约说明。
- miniprogram/utils/tabMotion.js：共享页面入场触发。
- miniprogram/app.wxss：方向入场动画公共类。
- pages/index/index、pages/submit/submit、pages/members/members、pages/mySubmit/mySubmit 的 js、wxml：消费方向并为页面 body 添加动画类。

## 边界与验证
冷启动和重复显页无有效来源时直接落位，不播放动画。页面隐藏时清空入场类，避免返回详情时重播。快速连点依靠一次性来源、最新渲染回调和每次目标页重新定位；switchTab 失败清除本次来源。保留启动显隐状态，不修改业务请求、滚动及表单逻辑。

先执行小程序所有 JS 的 node --check，再用隔离组件模拟检查左右、跨格、无切换、过期回调及切页失败。执行 npx jest；视觉验收需微信开发者工具或真机，无法运行时明确报告。
