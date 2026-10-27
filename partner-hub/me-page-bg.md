# 「我的」页顶部背景 · 落地说明（v151 定稿）

> 目标：把 `preview/partner-hub-gounucai-v151` 里已验证的「我的」页背景方案，搬到任何真实页面。
> 三端（站员 / 社干 / 超管）共用同一套，无需区分。

## 0. 资产

- 图片：`assets/me-bg.jpg`（1264 × 732，338 KB，园林线稿）

## 1. 结构（放在页面滚动容器最前面，与内容同级）

```html
<div class="mebg">
  <div class="mebg-img"></div>
  <div class="mebg-veil"></div>
</div>
```

父容器（如 `.view` / `page`）必须 `position: relative`。

## 2. 样式

```css
/* 背景层：通栏（用负 left/right 抵消父级左右内边距），高度＝图高 */
.mebg{
  position:absolute; top:0; left:-16px; right:-16px; height:226px;
  z-index:0; pointer-events:none; overflow:hidden;
}
/* 园林图：390 宽原比例；底部 46%→92% 渐隐（避免图片断成硬边） */
.mebg-img{
  position:absolute; inset:0;
  background:url(assets/me-bg.jpg) no-repeat 0 0;
  background-size:390px auto;
  opacity:1;
  -webkit-mask-image:linear-gradient(180deg,#000 46%,rgba(0,0,0,.42) 70%,rgba(0,0,0,0) 92%);
          mask-image:linear-gradient(180deg,#000 46%,rgba(0,0,0,.42) 70%,rgba(0,0,0,0) 92%);
}
/* 白纱布：从左往右；纵向也做淡出，只在文字区生效（否则卡片左下会白成一团） */
.mebg-veil{
  position:absolute; inset:0; z-index:1;
  background:linear-gradient(90deg,
    rgba(255,255,255,1) 0%,
    rgba(255,255,255,.72) 26%,
    rgba(255,255,255,0) 57%);
  -webkit-mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.85) 42%,rgba(0,0,0,.25) 62%,rgba(0,0,0,0) 76%);
          mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.85) 42%,rgba(0,0,0,.25) 62%,rgba(0,0,0,0) 76%);
}

/* 顶部介绍带：透明，让出背景 */
.wel.wel-solo{ background:transparent; }
.wel.wel-solo::before{ display:none; }      /* 关掉原来那张素描校园图 */
.wel.wel-solo > *{ position:relative; z-index:2; }

/* 白卡＝液态玻璃：上移 13px 压住背景 */
.me-rows{
  position:relative; z-index:1; margin-top:-13px;
  border-radius:20px; overflow:hidden;
  background:rgba(255,255,255,.31);
  -webkit-backdrop-filter:url(#liquid-warp);
          backdrop-filter:url(#liquid-warp);
  box-shadow:
    0 12px 34px -14px rgba(0,0,0,.22),
    inset 0 1px 0 rgba(255,255,255,.75),
    0 0 0 1px rgba(255,255,255,.55);
}
.me-rows .row{ background:transparent; }
```

## 3. 折射滤镜（液态玻璃的关键）

页面底部放一次：

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <filter id="liquid-warp" x="-18%" y="-18%" width="136%" height="136%"
          color-interpolation-filters="sRGB">
    <feImage id="warp-map" result="map" preserveAspectRatio="none"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="22"
      xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</svg>
<script>
(function(){
  /* 位移贴图：R=x 位移、G=y 位移；中心 128（不动），越靠边按法线方向偏得越多 */
  var W=180,H=260,c=document.createElement('canvas');
  c.width=W;c.height=H;
  var ctx=c.getContext('2d'),im=ctx.createImageData(W,H),cx=W/2,cy=H/2;
  for(var y=0;y<H;y++)for(var x=0;x<W;x++){
    var dx=(x-cx)/cx,dy=(y-cy)/cy,r=Math.sqrt(dx*dx+dy*dy);
    var k=Math.max(0,(r-0.42)/0.58); k=k*k;
    var i=(y*W+x)*4;
    im.data[i]=128+dx*k*127; im.data[i+1]=128+dy*k*127; im.data[i+2]=128; im.data[i+3]=255;
  }
  ctx.putImageData(im,0,0);
  var fe=document.getElementById('warp-map');
  if(fe)fe.setAttribute('src',c.toDataURL());   /* 少数环境要 href，可两个都设 */
})();
</script>
```

> 小程序里 `backdrop-filter: url()` 不支持，必须降级：去掉 url() 只留半透明白底
> （`background:rgba(255,255,255,.66)`），否则会整块消失。

## 4. 参数表（改这几个数就行）

| 参数 | 值 | 作用 |
|---|---|---|
| 图宽 | `390px auto` | 图在屏幕上的宽度（= 屏宽） |
| 图底渐隐 | `46% → 92%` | 图从卡片第一行开始变淡 |
| 白纱布 | `1 / .72@26% / 0@57%` | 左侧文字区的提亮范围 |
| 纱布纵向淡出 | `0 / .85@42% / .25@62% / 0@76%` | 让纱布只管上半，卡片区不白 |
| 卡片白度 | `.31` | 越小越透 |
| 卡片上移 | `13px` | 压住背景的深度 |
| 折射强度 | `scale 22` | 0 = 关掉折射 |

## 5. 验收（已在预览里跑过 21 项全过）

- 三端「我的」页都有背景层、图 390px、白纱布、玻璃卡、上移 13px、折射滤镜可用、无横向溢出
- 卡片第一行背后是桥/水池（浅色），文字可读；第二行起渐白

## 6. 已知限制

- `backdrop-filter: url(#filter)` 只在 Chromium 系有效；Safari / 小程序需要降级为纯半透明白底（无折射）。
- 图是 1264 × 732 的横图，屏幕上按 390 宽铺时高 226；要换图必须保证"卡片第一行落在图片下部浅色区"，否则文字会糊。
