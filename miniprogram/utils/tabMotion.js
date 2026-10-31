// 只消费 tabBar 返回的方向，业务数据、滚动与弹层保持由页面管理。
function show(page, index) {
  const version = page._tabMotionVersion = (page._tabMotionVersion || 0) + 1;
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  const direction = bar ? bar.setSelected(index) : 0;
  page.setData({ tabMotion: direction ? 'tab-content-prepare' : '' }, () => {
    if (version !== page._tabMotionVersion || !direction) return;
    page.setData({ tabMotion: direction > 0 ? 'tab-content-right' : 'tab-content-left' });
  });
}

function hide(page) {
  page._tabMotionVersion = (page._tabMotionVersion || 0) + 1;
  page.setData({ tabMotion: '' });
}

module.exports = { show, hide };
