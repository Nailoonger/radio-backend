/**
 * 生成 tabBar 占位 PNG 图标（81×81，微信官方推荐尺寸）
 * 6 个文件：home / home-active / edit / edit-active / user / user-active
 * 颜色：未选中 #94a3b8（灰），选中 #06b6d4（青蓝主题色）
 *
 * 用纯 Node 手写 PNG + 简单几何填充（无外部依赖）。
 * 图形用大像素块构成（粗描边风），保证小尺寸下仍清晰。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 81;
const OUT = path.resolve(__dirname);

/**
 * 创建 RGBA 像素画布
 */
function createCanvas(w, h) {
  return Buffer.alloc(w * h * 4, 0);
}

function setPx(buf, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

/**
 * 在 (cx,cy) 中心绘制实心矩形（带描边感）
 */
function fillRect(buf, x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(buf, x, y, r, g, b);
}

/**
 * 在 (cx,cy) 中心绘制填充圆
 */
function fillCircle(buf, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPx(buf, x, y, r, g, b);
    }
  }
}

/**
 * 圆环描边
 */
function strokeCircle(buf, cx, cy, radius, thickness, r, g, b) {
  const ro = radius, ri = radius - thickness;
  for (let y = cy - ro; y <= cy + ro; y++) {
    for (let x = cx - ro; x <= cx + ro; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= ro * ro && d2 >= ri * ri) setPx(buf, x, y, r, g, b);
    }
  }
}

/**
 * 绘制 home 图标：屋顶 + 房子
 */
function drawHome(buf, r, g, b) {
  // 屋顶三角
  for (let y = 18; y <= 36; y++) {
    const w = Math.min(y - 18, 36 - y) + 4;
    for (let x = 40 - w; x <= 40 + w; x++) setPx(buf, x, y, r, g, b);
  }
  // 房身
  fillRect(buf, 18, 36, 62, 64, r, g, b);
  // 门（透明镂空）
  fillRect(buf, 34, 46, 46, 64, 0, 0, 0);
  // 重画门内颜色（让门看起来是空心，改为白底）
  fillRect(buf, 35, 47, 45, 63, 255, 255, 255);
  // 屋顶尖
  setPx(buf, 40, 17, r, g, b);
}

/**
 * 绘制 edit 图标：铅笔斜放
 */
function drawEdit(buf, r, g, b) {
  // 铅笔主体（45度斜放，简化为矩形 + 笔尖三角）
  // 笔身
  for (let i = 0; i < 40; i++) {
    const x = 22 + i, y = 60 - i;
    // 粗描边
    fillRect(buf, x - 3, y - 3, x + 3, y + 3, r, g, b);
  }
  // 笔尖三角（右下角）
  // 已在循环末尾覆盖
  // 顶部橡皮（圆角）
  fillCircle(buf, 22, 60, 4, r, g, b);
  // 笔尖（白色三角，模拟削尖）
  const tipX = 62, tipY = 20;
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = -dy; dx <= 0; dx++) {
      setPx(buf, tipX + dx, tipY + dy + (40 - 0), 255, 255, 255);
    }
  }
}

/**
 * 绘制 user 图标：头 + 身
 */
function drawUser(buf, r, g, b) {
  // 头
  fillCircle(buf, 40, 28, 13, r, g, b);
  // 肩膀（半圆）
  for (let y = 44; y <= 66; y++) {
    const w = Math.round(20 * Math.sqrt(1 - ((y - 60) / 22) ** 2));
    if (y < 50) {
      fillRect(buf, 40 - w, y, 40 + w, y + 1, r, g, b);
    } else {
      fillRect(buf, 40 - w, y, 40 + w, y, r, g, b);
    }
  }
  // 底部填充
  fillRect(buf, 14, 64, 66, 66, r, g, b);
}

/**
 * 输出 PNG：仅支持 8-bit RGBA（最简单）
 */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT: 每行前加 filter byte=0
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// 简易 CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// === 主流程 ===
function makeIcon(drawer, color) {
  const c = createCanvas(SIZE, SIZE);
  // 透明背景，绘制前景
  drawer(c, color[0], color[1], color[2]);
  return encodePNG(SIZE, SIZE, c);
}

const GRAY = [148, 163, 184];    // #94a3b8
const CYAN = [6, 182, 212];      // #06b6d4

const files = [
  ['home.png', drawHome, GRAY],
  ['home-active.png', drawHome, CYAN],
  ['edit.png', drawEdit, GRAY],
  ['edit-active.png', drawEdit, CYAN],
  ['user.png', drawUser, GRAY],
  ['user-active.png', drawUser, CYAN],
];

for (const [name, drawer, color] of files) {
  const buf = makeIcon(drawer, color);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`✓ ${name}  ${buf.length} bytes`);
}

console.log('所有图标已生成到 ' + OUT);
