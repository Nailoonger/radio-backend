# =================================================================
#  菁悠广播站管理后台 - 生产镜像（多阶段构建）
#  第一阶段：容器内 npm ci + vite build 生成 dist（不再依赖主机预构建）
#  第二阶段：nginx 只装构建产物
# =================================================================

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /build

# 先拷依赖清单装依赖（利用层缓存），再拷源码
COPY package*.json ./
RUN npm ci --registry=https://mirrors.cloud.tencent.com/npm/
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# 从构建阶段拷贝产物（含 Vue assets）
COPY --from=build /build/dist ./

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

# 健康检查必须探 127.0.0.1：容器里没有 getent 配置，busybox wget 解析 localhost
# 会先试 ::1（IPv6），而 nginx 只 listen 了 IPv4 的 80 → 永远 Connection refused，
# 容器会被误标成 unhealthy（2026-09-19 实测）。
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=15s \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
