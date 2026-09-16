// utils/format.js
module.exports = {
  /** 状态码 -> 文案 */
  submitStatusText(s) {
    return ['待审核', '已通过', '已驳回'][s] || '未知';
  },
  submitStatusClass(s) {
    return ['tag-pending', 'tag-pass', 'tag-reject'][s] || 'tag-pending';
  },
  /** 时间戳 -> yyyy-MM-dd HH:mm */
  fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  /** "暂无" 兜底 */
  orDash(v) {
    return v || '-';
  },
};
