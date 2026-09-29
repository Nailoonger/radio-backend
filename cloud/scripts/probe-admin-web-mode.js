// 探测服务器上部署的 admin-web 是 direct 还是 cloud
(async () => {
  const base = 'http://129.28.26.180';
  let r, html;
  try {
    r = await fetch(base + '/', { signal: AbortSignal.timeout(15000) });
    html = await r.text();
  } catch (e) {
    console.log('首页不可达:', e.message);
    return;
  }
  console.log('首页 HTTP ' + r.status + '，长度 ' + html.length);
  const js = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
  console.log('引用 JS: ' + (js.join(', ') || '(无)'));
  for (const f of js) {
    const u = f.startsWith('http') ? f : base + (f.startsWith('/') ? '' : '/') + f;
    let t;
    try { t = await (await fetch(u, { signal: AbortSignal.timeout(30000) })).text(); }
    catch (e) { console.log('  拉取失败 ' + f + ': ' + e.message); continue; }
    const cloudHit = /tcloudbase\.com/.test(t);
    const apiHit = /["']\/api["']/.test(t);
    console.log('  ' + f + '  大小=' + t.length + '  含云地址=' + cloudHit + '  含"/api"=' + apiHit);
    const m = t.match(/https:\/\/[a-z0-9-]+\.tcloudbase\.com[^"']*/i);
    if (m) console.log('     云地址 → ' + m[0]);
  }
})();
