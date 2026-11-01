// pages-partner/message/message.js · v2（2026-10-28 审核线对齐 v151）
//
// ⚠️ v151 定稿：**留言不再单独一套 UI**
//   「留言已并入统一的审核队列：类型切到「留言」就是这一屏的内容。」
//   所以这一页不再自己拉列表、自己画筛选，也不再是第二套留言审核界面 ——
//   打开即转到统一审核台的留言档（review?type=message）。
//
// 为什么保留这个文件而不是删掉：
//   1) app.json 里还有这个路由，旧版本小程序 / 收藏链接可能仍指向它，直接删会白屏；
//   2) 工作台卡片若还有旧链接，落到这里也能正确转过去。
// 真正的列表与动作全部在 `pages-partner/review/review`（含留言的通过 / 屏蔽）。

Page({
  onLoad() {
    wx.reLaunch({
      url: '/pages-partner/review/review?type=message',
      fail: () => {
        // reLaunch 失败（极少见）就退一层，别留白屏
        wx.navigateBack({ delta: 1 });
      },
    });
  },
});
