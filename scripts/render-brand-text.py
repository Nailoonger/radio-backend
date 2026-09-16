"""
将"菁悠广播站"5 个字渲染成透明背景的 PNG
字体：simkai（楷体，你系统自带），颜真卿风格楷书
用法：python scripts/render-brand-text.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

text = '菁悠广播站'
font_path = r'C:/Windows/Fonts/simkai.ttf'
out_path = r'C:/Users/Administrator/radio-backend/admin-web/public/brand-text.png'

# 字号大些保证清晰
font_size = 96

try:
    font = ImageFont.truetype(font_path, font_size)
except Exception as e:
    print(f'字体加载失败: {e}')
    raise

# 测量文字实际尺寸
bbox = font.getbbox(text)
print(f'文字 bbox: {bbox}')
w = bbox[2] - bbox[0] + 60
h = bbox[3] - bbox[1] + 60

# 透明背景
img = Image.new('RGBA', (w, h), (255, 255, 255, 0))
draw = ImageDraw.Draw(img)

# 主文字：深色 #0f172a
draw.text((30, 10), text, font=font, fill='#0f172a')

# 保存（PNG 自动保留 alpha）
os.makedirs(os.path.dirname(out_path), exist_ok=True)
img.save(out_path, 'PNG')

# 顺便生成一个浅色版本（用于 footer / 水印）
img_light = Image.new('RGBA', (w, h), (255, 255, 255, 0))
draw_light = ImageDraw.Draw(img_light)
draw_light.text((30, 10), text, font=font, fill=(15, 23, 42, 90))  # alpha=90/255 浅色
out_light = out_path.replace('.png', '-light.png')
img_light.save(out_light, 'PNG')

print(f'主图: {out_path} ({img.size[0]}x{img.size[1]})')
print(f'浅色: {out_light}')
print('完成！')
