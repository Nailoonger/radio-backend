'use strict';
/**
 * 伙伴端「可排时间」页时段方块视觉校验（2026-11-01）
 *
 * 起因（陛下截图打回）：「站员端可排时间的页面时间段胶囊未点亮时与背景融合了看不出区别」。
 * 根因：`.avslot.off{background:#F5F5F7;border-color:transparent}` —— 灰底 #F5F5F7 与页面
 *       羊皮纸底 var(--parchment,#F5F5F7) **是同一个色值**，描边又透明 ⇒ 方块的边界整个消失。
 *       v151 原型里压根没有 .off 这条规则：未选中就是最基础的 .avslot（#FFF 底 + #E1E3EA 描边）。
 *
 * 判据（任一不满足即退出码 1）：
 *   ① 基础态 .avslot 必须是「白底 + 非透明描边」（未选中靠这个和页面底色分开）
 *   ② .avslot.off 不许改 background / border-color（改了就等于把基础态抹掉）
 *   ③ availability.wxss 里不许出现 `border-color: transparent`
 *   ④ 全站伙伴端 wxss 扫一遍：同一个规则块里「羊皮纸色底 + 透明描边」= 隐形块，直接判失败
 *   ⑤ 两态口径（on / off）不变，两处渲染（站员页 + 代录弹层）都吃到 .avslot
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'miniprogram/pages-partner/availability/availability');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
/** 去掉 /* *\/ 注释再解析 —— 否则注释里引用的旧写法会被当成真规则命中（本脚本第一版就栽在这） */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const wxss = strip(read(BASE + '.wxss'));
const wxml = read(BASE + '.wxml');
const js = read(BASE + '.js');

/** 取出某个选择器的规则体（最后一条同名规则生效，这点和 CSS 级联一致） */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ruleBody(css, selector) {
  const re = new RegExp(esc(selector) + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  let body = null;
  while ((m = re.exec(css))) body = m[1];
  return body;
}

// ── ① 基础态：白底 + 非透明描边 ──
const base = ruleBody(wxss, '.avslot');
ok('.avslot 有基础态规则', !!base);
ok('.avslot 基础态是白底（未选中靠白底浮在羊皮纸上）',
  !!base && /background\s*:\s*(#FFF|#FFFFFF|var\(--canvas)/i.test(base),
  '基础态背景不是白色 —— 未选中态会和页面底色融在一起');
ok('.avslot 基础态有描边',
  !!base && /border\s*:/.test(base),
  '基础态没有 border，方块没有边界');
ok('.avslot 基础态描边不透明',
  !!base && !/border(-color)?\s*:[^;]*transparent/i.test(base),
  '基础态描边是 transparent');

// ── ② .avslot.off 不许改背景 / 描边 ──
const off = ruleBody(wxss, '.avslot.off');
if (off === null) {
  ok('.avslot.off 没有覆盖基础态（原型 v151 即如此）', true);
} else {
  ok('.avslot.off 不改背景色',
    !/background/i.test(off),
    `.avslot.off 里写了 background —— 一旦写成 #F5F5F7 就和页面底色同色，方块会隐形。当前：${off.trim()}`);
  ok('.avslot.off 不改描边色',
    !/border(-color)?\s*:[^;]*transparent/i.test(off),
    `.avslot.off 把描边设成透明了。当前：${off.trim()}`);
}

// ── ③ 本页不许出现透明描边 ──
ok('availability.wxss 里没有 border-color: transparent',
  !/border(-color)?\s*:[^;]*transparent/i.test(wxss),
  '有 transparent 描边 —— 在灰底页面上等于没有边界');

// ── ④ 全站伙伴端：羊皮纸色底 + 透明描边 = 隐形块 ──
// 例外必须写在这里并说明理由 —— 别用「看着没问题」放过去。
const ALLOW = [
  {
    file: 'miniprogram/pages-partner/review-detail/detail.wxss',
    sel: '.preset',
    why: '在白卡 .reject-box 里（wxml 第 88 行），灰块嵌白卡 = 正确的次级块形态，不在灰底页面上',
  },
];
const PARCH = /background(-color)?\s*:\s*(#F5F5F7|var\(--parchment)/i;
const TRANSP = /border(-color)?\s*:[^;]*transparent/i;
// ⚠️ 路径一律归一成 / 再比对：CI 跑在 Linux、本机是 Windows，混着写会让 ALLOW 只在一边生效
const allowed = (file, sel) => ALLOW.some((a) => a.file === file && a.sel === sel);
const offenders = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (!e.name.endsWith('.wxss')) return;
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const css = strip(fs.readFileSync(p, 'utf8'));
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sel = m[1].trim().split('\n').pop().trim();
      const body = m[2];
      if (PARCH.test(body) && TRANSP.test(body) && !allowed(rel, sel)) {
        offenders.push(`${rel} → ${sel}`);
      }
    }
  });
})(path.join(ROOT, 'miniprogram/pages-partner'));
ok('伙伴端全站：没有「羊皮纸色底 + 透明描边」的隐形块',
  offenders.length === 0,
  offenders.join('\n      '));

// ── ⑤ 两态口径 + 两处渲染 ──
ok('js 里只有两态：能来(on) / 不能来(off)',
  /cls:\s*'on'/.test(js) && /cls:\s*'off'/.test(js),
  'stateOf 里找不到 on / off');
ok('js 里没有第三个「待选」态',
  !/cls:\s*''/.test(js),
  '出现了空 cls（第三个态）—— 陛下 2026-10-29 明确打回三态循环');
ok('wxml 站员页 + 代录弹层都渲染 .avslot',
  (wxml.match(/class="avslot \{\{s\.cls\}\}"/g) || []).length === 2,
  `class="avslot {{s.cls}}" 应出现 2 次，实际 ${(wxml.match(/class="avslot \{\{s\.cls\}\}"/g) || []).length} 次`);
ok('wxml 方块都在 .avg 行容器里',
  (wxml.match(/class="avg"/g) || []).length === 2,
  `class="avg" 应出现 2 次，实际 ${(wxml.match(/class="avg"/g) || []).length} 次`);
ok('.avslot-t / .avslot-s 都有样式',
  /\.avslot-t\s*\{/.test(wxss) && /\.avslot-s\s*\{/.test(wxss),
  '方块里的两行文字缺样式');
ok('.avslot.on 用 accent 浅底 + accent 描边',
  /\.avslot\.on\s*\{[^}]*var\(--accent-tint/.test(wxss) && /\.avslot\.on\s*\{[^}]*var\(--accent/.test(wxss),
  '选中态没走 accent 系列');
ok('页面底色是羊皮纸（与方块白底形成对比）',
  /\.page\s*\{[^}]*var\(--parchment/.test(wxss),
  '.page 底色不是羊皮纸 —— 对比关系的前提不成立了');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : `\n✓ 可排时间页时段方块：白底可见边界 · 两态 · 全站无隐形块（${out.length} 项）`);
process.exit(failed ? 1 : 0);
