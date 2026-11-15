'use strict';

/**
 * 统一提示：短文案走 wx.showToast，长文案走 wx.showModal。
 *
 * ⚠️⚠️ 为什么不能一律 showToast（2026-11-16 陛下截图退回）：
 *   `wx.showToast` 的 title 在 `icon:'none'` 下最多显示**两行**，再长直接被截断。
 *   后端那些带解释的长 message（例：「本周所有时段都已排满（5 格 × 2 首），
 *   剩下的不用再审，锁定排期时会自动驳回」）塞进去，用户只看到半句「剩下的不用再…」，
 *   等于没提示。这类文案必须换 showModal（完整、可滚、有关闭按钮）。
 *
 * 阈值 20：实测「该时段已排满（2/2），请先审别的时段」（19 字）两行放得下，
 *   再长就开始截断 ⇒ ≤ 20 字走 toast，> 20 字走 modal。
 */
const TOAST_MAX = 20;

/**
 * @param {string} message 要显示的文案
 * @param {{success?:boolean, title?:string}} [opts] success=true 用打勾 toast（仅短文案）
 */
function tip(message, opts) {
  const text = String(message === null || message === undefined ? '' : message).trim();
  if (!text) return;
  const o = opts || {};

  if (text.length <= TOAST_MAX) {
    wx.showToast({ title: text, icon: o.success ? 'success' : 'none' });
    return;
  }

  wx.showModal({
    title: o.title || '提示',
    content: text,
    showCancel: false,
    confirmText: '知道了',
    confirmColor: '#0066CC',
  });
}

module.exports = { tip, TOAST_MAX };
