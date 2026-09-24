// utils/format.js

/** 状态码 -> 文案（派生 status 单点定义见 docs/song-protocol.md）
 *  0 待审 / 1 已排期(点歌)·已通过(文稿) / 2 已驳回 / 3 候补中 / 4 [v2 遗留]
 *  5 已播放 / 6 已通过 · 待排期 / 7 已取消
 *  ⚠️ type 必须传：status=1 在点歌里叫「已排期」（有播出时段）、在文稿里叫「已通过」
 *     （文稿没有排期概念）。不传按「已通过」渲染，兼容老调用。
 */
function submitStatusText(s, type) {
  const st = Number(s);
  if (st === 1) return Number(type) === 1 ? '已排期' : '已通过';
  const TEXT = {
    0: '待审核',
    2: '已驳回',
    3: '候补中',
    4: '已补位 · 待审', // v2 遗留值，只可能出现在老数据里，协议版不再产生
    5: '已播放',
    6: '待排期',
    7: '已取消',
  };
  return TEXT[st] || '未知';
}

/** 状态胶囊 class —— 下标与派生 status 一一对应，别插队。
 *  琥珀=等人审 ／ 绿=排上了 ／ 红=没成 ／ 中性灰=在排队
 *  强调浅底=审过了等系统排 ／ 填灰=正常播完 ／ 描边=学生自己撤的（不作数）
 */
const STATUS_TAG = [
  'tag-pending',  // 0 待审核
  'tag-pass',     // 1 已排期 / 已通过
  'tag-reject',   // 2 已驳回（人工驳回，或系统「未排上」）
  'tag-queued',   // 3 候补中
  'tag-promoted', // 4 已补位 · 待审（v2 遗留）
  'tag-mute',     // 5 已播放
  'tag-acc',      // 6 已通过 · 待排期
  'tag-outline',  // 7 已取消
];
function submitStatusClass(s) {
  return STATUS_TAG[Number(s)] || 'tag-pending';
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
