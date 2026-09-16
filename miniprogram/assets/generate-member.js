/**
 * 生成 member.png / member-active.png（81×81）
 * 图标：抽象的"人 + 光环"图标，象征风采展示
 * 颜色：未选中 #94a3b8，选中 #06b6d4
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 81;
const OUT = path.resolve(__dirname);

function createCanvas(w, h) { return Buffer.alloc(w * h * 4, 0); }
function setPx(buf, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function fillRect(buf, x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(buf, x, y, r, g, b);
}
function fillCircle(buf, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPx(buf, x, y, r, g, b);
    }
  }
}
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

// 抽象图标：上半圆头 + 下半圆肩（描边风，更精致）
function drawMember(buf, r, g, b) {
  // 头：上半部分圆
  fillCircle(buf, 40, 30, 12, r, g, b);
  // 肩：下边较大的弧线（用描边圆环实现）
  strokeCircle(buf, 40, 64, 22, 7, r, g, b);
  // 胸前的"小星星"装饰（凸显"风采"）
  setPx(buf, 40, 64, r, g, b);
  setPx(buf, 39, 64, r, g, b);
  setPx(buf, 41, 64, r, g, b);
  setPx(buf, 40, 63, r, g, b);
  setPx(buf, 40, 65, r, g, b);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
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

const GRAY = [148, 163, 184];
const CYAN = [6, 182, 212];

for (const [name, color] of [['member.png', GRAY], ['member-active.png', CYAN]]) {
  const c = createCanvas(SIZE, SIZE);
  drawMember(c, color[0], color[1], color[2]);
  fs.writeFileSync(path.join(OUT, name), encodePNG(SIZE, SIZE, c));
  console.log(`✓ ${name}`);
}
