/**
 * 头像地址换算
 *
 * ═══════════ 为什么需要它 ═══════════
 * 成员头像在库里统一存**云存储 fileID**（`cloud://…`），因为：
 *   · 小程序 `<image src>` 原生支持 fileID（基础库 2.3.0+），**且不走下载域名校验**
 *     —— 这是当初上云开发的理由；换成 `https://…` 反而会被「合法域名」拦死。
 *   · 浏览器（admin-web）不认 `cloud://`，直接塞进 `<img src>` 是一张坏图。
 *
 * 所以只在这一处做换算，所有 admin-web 的头像显示都走 `avatarSrc()`。
 *
 * ═══════════ 换算规则（官方文档「组件支持」页给的 WXS 示例，逐字对齐）═══════════
 *   cloud://<envId>.<bucket>/<path>  →  https://<bucket>.tcb.qcloud.la/<path>
 *
 * ⚠️⚠️ **前提是云存储权限为「所有用户可读」**（云开发控制台 → 存储 → 权限设置）。
 *    私有文件的直链会 403，那种情况必须改用 `cloud.getTempFileURL` 换临时链接
 *    （有有效期，最长 2 小时），代价是每次列表都要调一次接口。
 *    本项目是校园展示场景，用「所有用户可读」是对的。
 */

/** @returns {string} 换算失败时原样返回（宁可显示坏图，也别变成 undefined） */
export function cloudFileToHttps(fileID) {
  const url = String(fileID || '');
  if (url.indexOf('cloud://') !== 0) return url;

  // 官方示例：取环境段之后的第一个 '.' 到其后的第一个 '/'
  const first = url.indexOf('.');
  const end = url.indexOf('/', first);
  if (first < 0 || end < 0) return url;

  return `https://${url.slice(first + 1, end)}.tcb.qcloud.la/${url.slice(end + 1)}`;
}

/**
 * 给 `<img :src>` / `<el-avatar :src>` / `<el-upload>` 预览用。
 * 传什么都安全：空值返回空串，http(s) 原样返回，未上传时的相对路径也照旧。
 */
export function avatarSrc(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.indexOf('cloud://') === 0 ? cloudFileToHttps(s) : s;
}

export default avatarSrc;
