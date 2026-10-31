// pages-partner/components/partner-tabbar/index.js
//
// 伙伴端底部导航（v151 定稿口径，2026-10-27 落地）
//
// ⚠️ 伙伴端是分包，页面不在 app.json 的 tabBar.list 里 ⇒ 系统 tabBar 不显示，
//    底部导航只能自己画（每个 tab 页挂这一个组件，浮动白胶囊 dock）。
//
// tab 清单 = v151 原型 TABS 的机械搬移，别自己增删：
//   站员 member        4 个：工作台(home) / 稿件(my-drafts) / 班表(schedule) / 我的(me)
//   社干·超管 manager   5 个：工作台(desk) / 审核(submissions) / 稿件 / 班表(scheduling) / 我的
//
// 角标口径（v151 TODO 唯一事实源）：**父页面算好数字传进来**，组件不算数 ——
//   同一件事只归一处、归零即隐（badge ≤ 0 不渲染）、> 99 显示 99+。

const TABS = {
  member: [
    { id: 'home', name: '工作台', icon: 'home' },
    { id: 'my-drafts', name: '稿件', icon: 'doc' },
    { id: 'schedule', name: '班表', icon: 'cal' },
    { id: 'me', name: '我的', icon: 'me' },
  ],
  manager: [
    { id: 'desk', name: '工作台', icon: 'pen' },
    { id: 'submissions', name: '审核', icon: 'rev' },
    { id: 'my-drafts', name: '稿件', icon: 'doc' },
    { id: 'scheduling', name: '班表', icon: 'cal' },
    { id: 'me', name: '我的', icon: 'me' },
  ],
};
// 超管 = 社干同一套（v151 原型：超管具备社干所有功能，底栏完全一致）
TABS.super = TABS.manager;

function badgeText(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';        // 归零即隐
  return v > 99 ? '99+' : String(v);
}

Component({
  properties: {
    // member | manager | super（member 通道就绪前，页面只会传后两种）
    role: {
      type: String,
      value: 'manager',
      observer() { this.build(); },
    },
    // 当前高亮的 tab id
    active: {
      type: String,
      value: '',
      observer() { this.build(); },
    },
    // 角标：{ tabId: 件数 }，父页面从待办唯一事实源算出
    badges: {
      type: Object,
      value: {},
      observer() { this.build(); },
    },
  },

  data: {
    tabs: [],
  },

  lifetimes: {
    attached() { this.build(); },
  },

  methods: {
    build() {
      const role = this.data.role === 'member' ? 'member' : 'manager';
      const badges = this.data.badges || {};
      const active = this.data.active;
      this.setData({
        tabs: (TABS[role] || []).map((t) => ({
          id: t.id,
          name: t.name,
          icon: t.icon,
          on: t.id === active,
          badge: badgeText(badges[t.id]),
        })),
      });
    },

    onTap(e) {
      const id = e.currentTarget.dataset.id;
      if (!id) return;
      // 高亮由父页面的 active 驱动；这里只上报意图，跳不跳、跳哪由父页面定
      // （未落地页在父页面里 toast，不由组件决定）
      this.triggerEvent('switch', { id });
    },
  },
});
