# 伙伴端（partner-hub）

「菁悠广播站」站员/社干/超管三身份的**伙伴端**原型与交付基线。
现为 **v151 定稿**（2026-10-27）。

## 文件

| 文件 | 作用 |
|---|---|
| `app.html` | **全部 69 屏**都在这一个文件里（三身份 × 各自场景），底部/侧边切换 |
| `index.html` | 72 屏全览（每屏用 iframe 实时渲染 `app.html?role=&scene=`，不是截图） |
| `wall.html` | 大屏墙（同 index，另一种排布） |
| `assets/` | `me-bg.jpg`（「我的」页园林背景 1264×732）、站徽等 |
| `me-page-bg.md` | 「我的」页背景的完整落地说明（结构 / CSS / 折射滤镜 / 参数表 / 降级限制） |

## 怎么跑

直接双击 `app.html` 即可（纯静态，无构建、无依赖）。
线上地址：https://jingyou-partner-hub.app.workbuddy.host/

## 技术要点（改之前先看）

1. **单文件架构**：`SCENES` 数组定义 69 屏（id / role / nav / tab / title），每屏一个 `V[sceneId]` 渲染函数，
   `renderAll()` 重绘。改一屏只需改对应 `V.xxx`。
2. **状态 `S`**：全部交互状态挂在 `S` 上（角色、场景、弹层开关、草稿、筛选…），`renderAll()` 后重建 DOM。
3. **事件委托**：`data-act`（动作）/ `data-go`（跳转）/ `data-*`（局部操作）统一在 `document` 上分发；
   输入类走 `input`，下拉（`select`）单独走 `change`。
4. **弹层**：`.sheet` 底部抽屉，统一 `max-height:75vh` + **整块滚动**（不要把标题/按钮固定，也不要内部再套滚动区）。
5. **「我的」页背景**（v151）：`.mebg`（页面级背景层，通栏）→ `.mebg-img`（图 + 底部渐隐 mask）
   → `.mebg-veil`（横向白纱布 + 纵向淡出）；卡片 `.me-rows` 是液态玻璃（`backdrop-filter:url(#liquid-warp)`），
   上移 13px 压住背景。细节见 `me-page-bg.md`。
6. **液态玻璃三件套**（判据，别搞错）：
   - 中央**原样透过**（`blur` 必须是 0，整块模糊＝磨砂，不是玻璃）
   - 边缘**厚光**（边框 + `inset 0 1px 0` 高光 + 一圈 `inset` 柔白）
   - **折射**（`feImage` 位移图 + `feDisplacementMap`，中心 128 不动、边缘按法线弯折）
7. **视觉铁律**：唯一强调色 `#0066CC`；不深色（白卡 + 深色字 + 羊皮纸底）；单行元素 9999 圆角、
   内容卡片 18/20 圆角；手机里不加装饰性描边框。

## 发布

```bash
# 本机
npx workbuddy-sites deploy --dir partner-hub    # 或走平台的发布入口
```
发布是**覆盖同一个应用**（`jingyou-partner-hub`），链接不变，不要新建应用。

## 版本

当前 **v151**（我的页背景定稿：图 390px / 白纱布 1→.72@26%→0@57% / 卡片 31% 玻璃 / 上移 13px）。
历史版本在 `preview/partner-hub-gounucai-v<N>/`（v105–v151），每次改动一个目录，不覆盖旧版。
