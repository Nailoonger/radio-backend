# =================================================================
#  菁悠广播站管理后台 - 生产镜像
#  ⚠️ 必须先在主机上跑 `npm run build` 生成 dist/
#  镜像只 COPY dist + public 资源，不再容器内 build
# =================================================================

# ---------- runtime ----------
FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# 拷贝构建产物（含 Vue assets + public 资源）
COPY dist ./

# 显式拷所有 public/ 资源（防止 dist 漏）
COPY public/station-badge.png     /usr/share/nginx/html/station-badge.png
COPY public/station-logo.jpg      /usr/share/nginx/html/station-logo.jpg
COPY public/brand-text.png       /usr/share/nginx/html/brand-text.png
COPY public/brand-text-light.png /usr/share/nginx/html/brand-text-light.png
COPY public/illustration.svg     /usr/share/nginx/html/illustration.svg
COPY public/watermark.png        /usr/share/nginx/html/watermark.png
COPY public/favicon.ico          /usr/share/nginx/html/favicon.ico

# 调试：build 完成后立即列出文件（确认资源已打入）
RUN ls -la /usr/share/nginx/html/ | grep -E "station|brand|illustration|watermark|favicon" || \
    (echo "WARN: 关键文件缺失" && ls -la /usr/share/nginx/html/)

# 拷贝 nginx 配置
COPY deploy/nginx-admin.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]