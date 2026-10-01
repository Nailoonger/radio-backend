const fs = require('fs');
const path = require('path');

// 一律从仓库根定位，这样从任何 cwd 运行都成立
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram/app.wxss');
const PAGES = [
  { name: 'submit', dir: path.join(ROOT, 'miniprogram/pages/submit') },
  { name: 'mySubmit', dir: path.join(ROOT, 'miniprogram/pages/mySubmit') },
  // ── 管理端分包（2026-10-01 加）────────────────────────────────
  // ⚠️ 目录名与文件名不一致的用 file 显式给出（review-detail/detail）
  { name: 'login', dir: path.join(ROOT, 'miniprogram/pages-admin/login') },
  { name: 'todo', dir: path.join(ROOT, 'miniprogram/pages-admin/todo') },
  { name: 'review', dir: path.join(ROOT, 'miniprogram/pages-admin/review') },
  { name: 'detail', dir: path.join(ROOT, 'miniprogram/pages-admin/review-detail'), file: 'detail' },
  { name: 'message', dir: path.join(ROOT, 'miniprogram/pages-admin/message') },
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

/** wxml 里 bind / catch 绑的处理函数名（含 bind:tap / capture-bind:tap 写法） */
function handlersInWxml(wxml) {
  const set = new Set();
  const re = /\b(?:capture-)?(?:bind|catch)[:-]?[a-zA-Z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(wxml))) set.add(m[1]);
  return set;
}

/**
 * js 里有没有这个名字。
 * ⚠️ 刻意宽松（\b 词边界即可）：`goBack() {}`、`goBack: function () {}`、
 *    Page({ ... }) 里写成箭头函数… 各种写法都能命中；宁可漏报也不误报。
 *    这条检查是给「wxml 绑了一个 js 里不存在的方法」兜底 —— 那类错点击时才炸，
 *    光看代码和截图都发现不了（本次落地就真漏过一次 goBack）。
 */
function hasHandler(js, name) {
  return new RegExp('\\b' + name + '\\b').test(js);
}

let totalUndef = 0;
let totalBad = 0;

for (const p of PAGES) {
  const base = p.file || p.name;
  console.log('\n════ ' + p.name + ' ════');
  const wxmlRaw = fs.readFileSync(`${p.dir}/${base}.wxml`, 'utf8');
  // ⚠️⚠️ 分析前先**剥掉 wxml 注释**（换成等长空白，保住行号）：
  //   注释里写个 `<text>` 字面量（讲解这条坑时必然要写），会被标签配平 / 跨行检查
  //   当成真标签，报出一堆「假错」—— 2026-10-01 加 <text> 跨行检查时当场踩到。
  const wxml = wxmlRaw.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
  const wxss = fs.readFileSync(`${p.dir}/${base}.wxss`, 'utf8');
  const js = fs.readFileSync(`${p.dir}/${base}.js`, 'utf8');
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

  // 事件处理函数：wxml 绑了但 js 里找不到 → 点下去才炸，必须静态拦
  const handlers = handlersInWxml(wxml);
  const missH = [...handlers].filter((h) => !hasHandler(js, h)).sort();
  if (missH.length) {
    console.log('  ⚠ 事件处理函数未在 js 里找到: ' + missH.join(', '));
    totalUndef += missH.length;
  } else {
    console.log('事件处理函数 ' + handlers.size + ' 个: 全部存在 OK');
  }

  // ⚠️⚠️ WXML **不是 HTML**：它不做实体解码，写了 `&amp;` 就原样显示成 "&amp;"
  //   （2026-10-01 管理端落地踩过：文案从 HTML 预览稿搬过来，三处 `&amp;` 全render 成字面量，
  //    渲染出来才看见 —— 看源码、看截图缩略图都发现不了）。WXML 里直接写 `&` 就行。
  const ents = [...new Set(wxml.match(/&[a-zA-Z]+;|&#\d+;/g) || [])];
  if (ents.length) {
    console.log('  ⚠ WXML 里出现 HTML 实体（会原样显示）: ' + ents.join(', '));
    totalUndef += ents.length;
  } else {
    console.log('HTML 实体: 无 OK');
  }

  // ⚠️⚠️ WXML 的 <text> **保留换行**（不做 HTML 那种空白折叠）：
  //   <text class="tag">
  //     已驳回
  //   </text>
  //   会渲染成「一个空行 + 一行字」—— 胶囊被撑高、字掉到底部。
  //   2026-10-01 真机踩过：列表页的 .tag 红/绿胶囊全错位（同页写在一行的 .fl 筛选胶囊是好的，
  //   这就是根因的对照证据）。表现只在渲染后可见，源码和缩略图都看不出来 ⇒ 必须静态拦。
  //   ⚠️ 只查 <text>，**不查 <textarea>**（那是输入框，多行内容是它自己的文案，无所谓）。
  const multilineText = [];
  const reText = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let mt;
  while ((mt = reText.exec(wxml))) {
    if (/\n/.test(mt[1])) {
      const line = wxml.slice(0, mt.index).split('\n').length;
      const head = mt[0].split('\n')[0].trim().slice(0, 40);
      multilineText.push('L' + line + ' ' + head);
    }
  }
  if (multilineText.length) {
    console.log('  ⚠ <text> 内容跨行（会多出一个空行，把元素撑高）:');
    multilineText.forEach((m) => console.log('      ' + m));
    totalUndef += multilineText.length;
  } else {
    console.log('<text> 跨行: 无 OK');
  }
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
