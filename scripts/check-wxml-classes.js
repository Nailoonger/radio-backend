const fs = require('fs');
const path = require('path');

// 一律从仓库根定位，这样从任何 cwd 运行都成立
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram/app.wxss');
const PAGES = [
  { name: 'submit', dir: path.join(ROOT, 'miniprogram/pages/submit') },
  { name: 'mySubmit', dir: path.join(ROOT, 'miniprogram/pages/mySubmit') },
];

// wxml 里由 js 动态给出的类名（{{item.statusClass}} 等），静态扫不到，显式白名单
const DYNAMIC = [
  'tag-pending', 'tag-pass', 'tag-reject', 'tag-queued', 'tag-promoted',
  'tag-mute', 'tag-acc', 'tag-outline',
];

function classesInCss(css) {
  const set = new Set();
  const re = /\.([A-Za-z][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(css))) set.add(m[1]);
  return set;
}

function classesInWxml(wxml) {
  const set = new Set();
  // ⚠️ 必须用 (?:^|\s) 锚定，否则 hover-class="none" 会被 class 的正则重复抓一次。
  //    这里把 class 和 hover-class 都当类名来源（hover-class 的值也是真类名），只滤掉 "none"。
  const re = /(?:^|\s)(?:hover-)?class="([^"]*)"/g;
  let m;
  while ((m = re.exec(wxml))) {
    const raw = m[1];
    // ① {{cond ? 'a' : 'b'}} 里的条件类名 —— 真盲区，必须抽。
    //    ⚠️ 只认 ? / : 后面的字符串：{{x === 'pending' ? 'on' : ''}} 里的 'pending'
    //    是参与比较的值、不是类名，误当成类名会报假未定义。
    const expr = raw.match(/[?:]\s*'([^']*)'/g) || [];
    expr.forEach((s) => {
      const c = s.replace(/^[?:]\s*'|'$/g, '').trim();
      if (c !== 'none' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(c)) set.add(c);
    });
    // ② 静态 token（剔掉整个 {{...}} 段，动态的已在 ① 处理）
    const v = raw.replace(/\{\{[^}]*\}\}/g, ' ');
    v.split(/\s+/).forEach((c) => {
      if (c !== 'none' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(c)) set.add(c);
    });
  }
  return set;
}

// 从 format.js 抓 STATUS_TAG 数组（动态胶囊的真实来源）
function statusTagsInJs(js) {
  const m = /STATUS_TAG\s*=\s*\[([\s\S]*?)\]/.exec(js);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))   // 剥行尾注释
    .join(',')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter((s) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s));
}

function tagsBalanced(xml) {
  const stack = [];
  const VOID = new Set(['image', 'input', 'import', 'include']);
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let m;
  let bad = [];
  while ((m = re.exec(xml))) {
    const whole = m[0];
    const tag = m[1];
    const selfClose = m[3] === '/';
    const isClose = whole.startsWith('</');
    if (VOID.has(tag) || selfClose) continue;
    if (isClose) {
      const top = stack.pop();
      if (top !== tag) bad.push(`</${tag}> 期望 </${top}>`);
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) bad.push('未闭合: ' + stack.join(','));
  return bad;
}

let totalUndef = 0;
let totalBad = 0;

for (const p of PAGES) {
  console.log('\n════ ' + p.name + ' ════');
  const wxml = fs.readFileSync(`${p.dir}/${p.name}.wxml`, 'utf8');
  const wxss = fs.readFileSync(`${p.dir}/${p.name}.wxss`, 'utf8');
  const defined = new Set([
    ...classesInCss(fs.readFileSync(APP, 'utf8')),
    ...classesInCss(wxss),
    ...DYNAMIC,
  ]);
  const used = classesInWxml(wxml);
  const undef = [...used].filter((c) => !defined.has(c)).sort();
  console.log('wxml 用到类名 ' + used.size + ' 个；未定义 ' + undef.length + ' 个');
  if (undef.length) { console.log('  未定义: ' + undef.join(', ')); totalUndef += undef.length; }

  const bad = tagsBalanced(wxml);
  console.log('标签配平: ' + (bad.length ? bad.join(' | ') : 'OK'));
  totalBad += bad.length;
}

// 动态胶囊：从 format.js 的 STATUS_TAG 取真实名单，逐个查是否真有样式
const APP_CSS = classesInCss(fs.readFileSync(APP, 'utf8'));
const tags = statusTagsInJs(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/format.js'), 'utf8'));
const tagMiss = tags.filter((t) => !APP_CSS.has(t));
console.log('\n════ 状态胶囊 ════');
console.log('共 ' + tags.length + ' 个: ' + tags.join(', '));
if (tagMiss.length) { console.log('  ⚠ 无样式定义: ' + tagMiss.join(', ')); totalUndef += tagMiss.length; }
else console.log('全部有样式定义 OK');

console.log('\n════ 汇总 ════');
console.log('未定义类名合计: ' + totalUndef);
console.log('标签问题合计: ' + totalBad);
