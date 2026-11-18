// utils/tabMotion.js · 切 tab 时页面内容的入场
//
// 2026-11-19 跟随「动画契约 v11」改写，两条硬约束：
//   ① 一次 onShow 最多一次 setData。旧版是「先挂 tab-content-prepare（opacity .6）、
//      回调里再挂动画类」两段 —— 两次 setData 常被合到同一批原生渲染里，
//      第一段没画出来就成了"闪一下"；画出来了又变成"先暗一帧再亮回来"。
//   ② 内容层只准动 opacity，绝不准动 transform。
//      transform 会让 .body 成为 position:fixed 后代的包含块 ⇒ 底栏、弹层、骨架层
//      跟着一起位移，整页抽搐。旧版的 translateX(±20rpx) 就是这个毛病。
//
// 方向（-1/0/1）由 tabBar.setSelected 给出：
//   有方向 = 真的从别的 tab 过来，播一次淡入；
//   无方向 = 详情页返回 / 冷启动 / 重复 onShow，什么都不播（那种时候放动画等于放大抖动）。

function show(page, index) {
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  const direction = bar ? bar.setSelected(index) : 0;
  const next = direction ? (direction > 0 ? 'tab-content-right' : 'tab-content-left') : '';
  if (page.data.tabMotion !== next) page.setData({ tabMotion: next });
}

function hide(page) {
  // 离开时清掉，下次进来才能重播；同时避免残留的 class 影响下拉刷新等场景
  if (page.data.tabMotion) page.setData({ tabMotion: '' });
}

module.exports = { show, hide };
