/**
 * Vue SFC 绑定自检：把 <template> 编译成 render 函数，收集里面的 `_ctx.xxx` 引用，
 * 与 <script setup> 的 bindings 对比。
 *
 * 为什么需要它：模板里写了一个 script 没定义的变量，Vue 编译期**不报错**、
 * 构建也不报错，运行时只是渲染成空 —— 这类错误只能靠真机看，代价高。
 * 这里用编译器自己的数据把它变成一次静态检查。
 *
 * 用法：node _vuecheck.js [文件...]
 */
const fs = require('fs');
const path = require('path');

// 一律从仓库根定位，这样从任何 cwd 运行都成立
const ROOT = path.resolve(__dirname, '..');
const SFC = require(path.join(ROOT, 'admin-web/node_modules/@vue/compiler-sfc'));
const { parse, compileScript, compileTemplate } = SFC;

/** 模板作用域内建变量 / 全局对象，出现在 _ctx 里也不算错 */
const ALLOW = new Set([
  '$event', '$slots', '$attrs', '$props', '$refs', '$emit', '$options',
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'JSON',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
]);

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { descriptor, errors } = parse(src, { filename: file });
  if (errors && errors.length) {
    return { file, fatal: errors.map((e) => String(e.message || e)) };
  }
  if (!descriptor.template) return { file, skipped: '没有 <template>' };
  if (!descriptor.scriptSetup && !descriptor.script) return { file, skipped: '没有 <script>' };

  const id = 'x' + Buffer.from(file).toString('hex').slice(0, 12);
  let bindings = {};
  try {
    const s = compileScript(descriptor, { id, inlineTemplate: false, genDefaultAs: '__sfc__' });
    bindings = s.bindings || {};
  } catch (e) {
    return { file, fatal: ['compileScript 失败：' + e.message] };
  }

  let code = '';
  try {
    const t = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id,
      compilerOptions: { bindingMetadata: bindings, prefixIdentifiers: true },
    });
    if (t.errors && t.errors.length) {
      return { file, fatal: t.errors.map((e) => String(e.message || e)) };
    }
    code = t.code || '';
  } catch (e) {
    return { file, fatal: ['compileTemplate 失败：' + e.message] };
  }

  // render 函数里对「非绑定」的访问会被编译成 _ctx.xxx
  const refs = new Set();
  const re = /_ctx\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code))) refs.add(m[1]);

  const declared = new Set(Object.keys(bindings));
  const missing = [...refs].filter((x) => !declared.has(x) && !ALLOW.has(x)).sort();
  // refs.size = render 里出现 _ctx.xxx 的个数 —— 已声明的绑定会被编译成 $setup.xxx，
  // 所以「未声明引用 0 个」才是正确结果（0 不是没检查到，是真的没有）。
  return { file, declared: declared.size, ctxRefs: refs.size, missing };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--sfc='));
const files = targets.length
  ? targets
  : [
      path.join(ROOT, 'admin-web/src/views/SubmitList.vue'),
      path.join(ROOT, 'admin-web/src/components/StatusTag.vue'),
    ];

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`${f}\n  跳过：文件不存在`); continue; }
  const r = check(f);
  console.log('\n════ ' + path.basename(f) + ' ════');
  if (r.fatal) { console.log('  ✗ ' + r.fatal.join(' | ')); bad += 1; continue; }
  if (r.skipped) { console.log('  跳过：' + r.skipped); continue; }
  console.log(`  script 绑定 ${r.declared} 个 · 模板里的未声明引用 ${r.ctxRefs} 个`);
  if (r.missing.length) {
    console.log('  ✗ 模板用到但 script 没定义：' + r.missing.join(', '));
    bad += r.missing.length;
  } else {
    console.log('  ✓ 模板引用的标识符全部有定义');
  }
}
console.log('\n════ 汇总 ════');
console.log(bad ? `发现 ${bad} 个问题` : '全部通过');
process.exit(bad ? 1 : 0);
