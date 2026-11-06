// utils/clubTicket.js —— 社团票据（输对密钥后拿到的 2 小时通行证）
//
// 为什么单独存一份、不塞进 app.globalData：
//   ① 它跟「学生登录态」是**两条独立的凭据** —— 退出登录时社团票据也该一起清，
//      但反过来，换社团（重新输另一把密钥）绝不能把学生登录态弄掉。
//   ② 小程序冷启动时 globalData 会重建，而票据还在有效期内，用户不该被要求重输。
//
// ⚠️ 只存票据，**不存密钥明文**。学生输的那 6 位码一旦落盘，就等于把钥匙抄了一份在手机上。
//    （后端也是同一口径：库里只留 sha256。）

const K_TICKET = 'club_ticket';
const K_CLUB = 'club_info';
const K_EXPIRE = 'club_ticket_expire';

function getTicket() {
  try {
    const t = wx.getStorageSync(K_TICKET) || '';
    if (!t) return '';
    const at = Number(wx.getStorageSync(K_EXPIRE) || 0);
    // 本地也判一次过期：省得每次都拿死票据去打接口、白挨一个 40102
    if (at && Date.now() > at) {
      clear();
      return '';
    }
    return t;
  } catch (e) {
    return '';
  }
}

function getClub() {
  try {
    return wx.getStorageSync(K_CLUB) || null;
  } catch (e) {
    return null;
  }
}

function save(ticket, club, expireAt) {
  try {
    wx.setStorageSync(K_TICKET, ticket || '');
    wx.setStorageSync(K_CLUB, club || null);
    wx.setStorageSync(K_EXPIRE, Number(expireAt) || 0);
  } catch (e) { /* 存不进去不致命，本页仍可用 */ }
}

/** 只更新社团信息（换头像后用），票据不动 */
function saveClub(club) {
  try { wx.setStorageSync(K_CLUB, club || null); } catch (e) { /* ignore */ }
}

function clear() {
  try {
    wx.removeStorageSync(K_TICKET);
    wx.removeStorageSync(K_CLUB);
    wx.removeStorageSync(K_EXPIRE);
  } catch (e) { /* ignore */ }
}

/**
 * 要票据；没有就跳去输码页并返回 ''
 *
 * ⚠️ 用 redirectTo 而不是 navigateTo：输码成功后直接 redirect 回来，
 *    否则用户进来又退出去会攒一串「提报 → 输码 → 提报 → 输码」的页面栈。
 */
function ensure(backUrl) {
  const t = getTicket();
  if (t) return t;
  const q = backUrl ? `?back=${encodeURIComponent(backUrl)}` : '';
  wx.redirectTo({ url: `/pages/club-code/club-code${q}` });
  return '';
}

module.exports = { getTicket, getClub, save, saveClub, clear, ensure };
