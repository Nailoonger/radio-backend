/**
 * 上传前压图 —— **不是审美选择，是被请求体上限逼出来的**
 *
 * ═══════════ 硬事实（2026-10-08 实测本环境 HTTP 访问服务）═══════════
 *   POST body   80KB → 200 OK
 *   POST body  150KB → **HTTP 413 EXCEED_MAX_PAYLOAD_SIZE**
 * 云函数「文本类型请求体」上限 100KB（CloudBase 文档），而 admin-web 切云之后
 * 走的就是这条 HTTP 访问服务通道。base64 还会让体积 +33%：
 *   ⇒ 2MB 的原图（2.7MB base64）**必然 413**，一张都传不上去。
 *
 * 所以上传前必须压。头像是小尺寸展示（列表 56px / 详情 114px，2 倍屏算 228px），
 * 400px 内、JPEG 质量 0.82 完全够用，压完通常 25~60KB
 * （base64 后 33~80KB，落在 100KB 预算内）。
 *
 * ⚠️ 仍留自适应降档：遇到复杂照片（大片树叶/噪点）可能压不到预算内，
 *    会依次降质量、再降边长，最多试 5 档。降完仍超预算也照样返回
 *    （由调用方决定是否提示），但**不静默截断**。
 *
 * ⚠️ direct 模式（直连原 Express + multer）没有这个限制，但压缩对它同样有益
 *    （服务器上传目录更小、加载更快），所以**两条通道共用同一份压缩逻辑**，
 *    不按通道分支 —— 少一个分支就少一类「只有某条通道会坏」的 bug。
 */

/** 目标：压完 ≤ 60KB（base64 后 ≈ 80KB，留 20KB 给 JSON 信封与其它字段） */
export const DEFAULT_BUDGET_BYTES = 60 * 1024;
export const DEFAULT_MAX_EDGE = 400;
export const DEFAULT_QUALITY = 0.82;

/** 依次尝试的 [边长, 质量]：先只降质量（保清晰度），不够再降边长 */
const LADDER = [
  [1, DEFAULT_QUALITY],
  [1, 0.7],
  [1, 0.6],
  [0.8, 0.7],
  [0.6, 0.7],
];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败，请换一张')); };
    img.src = url;
  });
}

function render(img, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');

  // ⚠️ 一定要先铺白底：输出的是 JPEG（不支持透明），透明像素会被填成**黑色**。
  //    带透明通道的 PNG 头像不铺底，上传后会变成黑边/黑块。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return cv;
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('图片编码失败'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * @param {File|Blob} file
 * @param {{maxEdge?:number, budgetBytes?:number}} [opts]
 * @returns {Promise<{blob:Blob, filename:string, size:number, width:number, height:number, quality:number, overBudget:boolean}>}
 */
export async function compressImage(file, opts = {}) {
  const maxEdge = opts.maxEdge || DEFAULT_MAX_EDGE;
  const budget = opts.budgetBytes || DEFAULT_BUDGET_BYTES;

  const img = await loadImage(file);

  let best = null;
  for (let i = 0; i < LADDER.length; i += 1) {
    const [edgeK, q] = LADDER[i];
    const canvas = render(img, Math.round(maxEdge * edgeK));
    const blob = await toBlob(canvas, q);   // eslint-disable-line no-await-in-loop
    best = {
      blob,
      width: canvas.width,
      height: canvas.height,
      quality: q,
    };
    if (blob.size <= budget) break;
  }

  // 统一改成 .jpg（原扩展名在压缩后已经不准了；服务端按魔数判类型，不看名字）
  const base = String(file.name || 'avatar').replace(/\.[^./\\]+$/, '');
  return {
    ...best,
    filename: `${base || 'avatar'}.jpg`,
    size: best.blob.size,
    overBudget: best.blob.size > budget,
  };
}

export default compressImage;
