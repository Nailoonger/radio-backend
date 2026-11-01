// pages-partner/components/rules-sheet/index.js · v1（2026-11-02）
//
// 排班规则「只读弹层」。给非超管（社干 / 站员）看当前生效的两条上限，不跳页面。
//
// ⚠️ 为什么要有它（2026-11-02 陛下）：「社干和站员可以查看目前生效的排班规则，
//    是弹窗而不是进去排班规则页面查看，而且竟然还能点动开关，但是保存不了」——
//    排班规则页是**超管的编辑页**（加减号 + 开关 + 保存），非超管进去只能看，
//    但开关是原生组件，手指一拨它自己会动（数据没变、保存按钮又是灰的）⇒ 看着就是坏的。
//
// 形态照原型 v151 v109 `roSheet()`：标题 + 只读清单 + 一个「关闭」，没有任何可控件。
// ⚠️ 但内容**只用真实数据**（每天 / 每周两条上限），不抄原型那 6 条静态说明 ——
//    那些文案（含「排班不使用个人权重…」）陛下已明确要求删掉。
//
// 接口：GET /partner/rules（只读；写权限在 rules 页，只有超管有）

const { adminRequest } = require('../../../utils/request');

Component({
  properties: {
    // 由页面控制开合：open=true 时拉一次规则（每次都拉，规则被超管改过能立刻看到）
    open: { type: Boolean, value: false },
  },

  data: {
    rows: [],
    loading: false,
    error: '',
  },

  observers: {
    open(v) { if (v) this.load(); },
  },

  methods: {
    load() {
      this.setData({ loading: true, error: '' });
      return adminRequest('/partner/rules', 'GET', {})
        .then((d) => {
          const items = (d && d.items) || [];
          this.setData({ loading: false, rows: items.map(toRow) });
        })
        .catch((err) => {
          this.setData({ loading: false, rows: [], error: (err && err.message) || '规则没拉到，稍后再看' });
        });
    },

    close() { this.triggerEvent('close'); },

    /** 吞掉弹层内部的点击/滑动，别透到遮罩上去（遮罩点了是关闭） */
    noop() {},
  },
});

/** 一条规则 → 只读行：{ key, name, sub, text, on } */
function toRow(x) {
  const r = x || {};
  const on = r.on !== false;
  const value = Number(r.value) || 1;
  return {
    key: r.key || Math.random().toString(36).slice(2),
    name: r.name || (r.key === 'day' ? '每天最多场次' : '每周最多场次'),
    // 副行只说实话：生效中 / 关掉了就是「不限制」（与服务端口径一致：关掉按 99 处理）
    sub: on ? '生效中' : '已关闭（不限制）',
    text: on ? value + ' 场' : '不限',
    on,
  };
}
