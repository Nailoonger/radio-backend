// utils/clubTime.js —— 广播通知线的时间显示
//
// ⚠️⚠️ 为什么不直接用 utils/format.js 的 fmtIso：
//    那条是给**服务端下发北京时间墙上时刻**（`...T18:00:00+08:00`）准备的，它取字符串里的
//    时分字段。而广播通知线的单据时间戳是 `new Date().toISOString()`（UTC，带 Z），
//    fmtIso 会把 14:20 显示成 06:20 —— 差 8 小时，且看起来完全像正常时间，最难发现。
//    所以这里统一 getUTC* + 8 小时再取，不依赖设备时区。

const BJ = 8 * 3600 * 1000;
const p2 = (n) => String(n).padStart(2, '0');

function bjDate(iso) {
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + BJ);
}

/** 「11-05 14:20」 */
function stamp(iso) {
  const d = bjDate(iso);
  if (!d) return '';
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** 「今天 14:20」/「昨天 09:05」/「11-05 14:20」 */
function rel(iso) {
  const d = bjDate(iso);
  if (!d) return '';
  const md = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  const now = bjDate(Date.now());
  const mdNow = `${p2(now.getUTCMonth() + 1)}-${p2(now.getUTCDate())}`;
  const y = bjDate(Date.now() - 86400000);
  const mdY = `${p2(y.getUTCMonth() + 1)}-${p2(y.getUTCDate())}`;
  if (md === mdNow) return `今天 ${hm}`;
  if (md === mdY) return `昨天 ${hm}`;
  return `${md} ${hm}`;
}

/** 「今天 14:20」里只要时分 */
function clock(iso) {
  const d = bjDate(iso);
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : '';
}

/** 秒数估算：口播按 4 字/秒（站里念通知的常见速度，只做参考，不当校验） */
function secondsText(chars) {
  const n = Number(chars) || 0;
  if (!n) return '';
  return `约 ${Math.max(1, Math.round(n / 4))} 秒`;
}

module.exports = { stamp, rel, clock, secondsText };
