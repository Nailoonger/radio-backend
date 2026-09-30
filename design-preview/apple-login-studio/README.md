# Apple Login Studio · 设计资产

这组 SVG 为新的登录页概念原创绘制。声音标记「声窗」以相向的开放括线包围三道声波，表达收听与表达的关系。

[查看效果图](concept.png) · [设计标准](design.md) · [内置 image_gen 生成提示词](generation-prompt.txt)

- `icons/soundmark.svg`：64 × 64 画布，4px 圆端描边，固定强调色 `#0066CC`，建议以 64px 显示。
- 其余图标：24 × 24 画布，1.65px 圆端描边，使用 `currentColor`，默认颜色 `#6E6E73`，建议以 24px 显示。
- 控件名称：`chevron-left`、`eye`、`eye-off`、`lock`、`arrow-right`、`shield-check`、`wechat`。
- 图标均含独立标题与 `role="img"`，无需字体、脚本或外部资源。内联使用可通过 CSS `color` 覆盖控件颜色；使用 `<img>` 时采用文件内的默认颜色。
- 本目录包含效果图、设计说明和 SVG 源文件，尚未接入小程序或管理后台。
