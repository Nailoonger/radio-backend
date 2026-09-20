// utils/format.js

/** 状态码 -> 文案（点歌规则 v2 五态）
 *  ⚠️ status=1 在点歌里叫「已排期」（有播出时段）、在文稿里叫「已通过」（文稿没有排期概念）。
 *     type 可选：不传按「已通过」渲染（兼容老调用）。
 */
function submitStatusText(s, type) {
  const st = Number(s);
  if (st === 1) return Number(type) === 1 ? '已排期' : '已通过';
  return ['待审核', '', '已驳回', '候补中', '已补位 · 待审'][st] || '未知';
}

/** 状态胶囊 class（3 候补中 = 中性灰；4 已补位待审 = 强调色浅底，是唯一「占着位还没人审」的状态） */
function submitStatusClass(s) {
  return ['tag-pending', 'tag-pass', 'tag-reject', 'tag-queued', 'tag-promoted'][Number(s)] || 'tag-pending';
}

/** 时间戳 -> yyyy-MM-dd HH:mm */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 服务端下发的 ISO -> MM-DD HH:mm
 * ⚠️ 直接取字符串里的「墙钟字段」，不经过 Date 换算：服务端给的是北京时间的墙上时刻
 *    （2026-09-20T18:00:00+08:00），若用 new Date() 再取 hours，设备时区一变就显示成别的点数。
 *    倒计时该用 Date.parse（绝对时刻），显示时刻该用这里。
 */
function fmtIso(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 毫秒 -> 「2 小时 15 分」/「3 小时」/「12 分 30 秒」（倒计时文案；服务端只给时刻，前端自己算） */
function fmtDur(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 时段规范串「2026-09-23 午间 12:20」->「9/23 午间 12:20」（列表副行用，去掉年份） */
function fmtSlot(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/);
  if (!m) return String(v);
  const rest = (m[4] || '').trim();
  return `${Number(m[2])}/${Number(m[3])}${rest ? ' ' + rest : ''}`;
}

/** 时间戳 -> 「9/19 18:31」（卡片副行「提交于 …」用） */
function fmtMd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "暂无" 兜底 */
function orDash(v) {
  return v || '-';
}

module.exports = {
  submitStatusText,
  submitStatusClass,
  fmtDate,
  fmtIso,
  fmtDur,
  fmtSlot,
  fmtMd,
  orDash,
};
