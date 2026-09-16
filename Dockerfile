# =================================================================
#  菁悠广播站后端 - 生产镜像
#  支持 MySQL（生产）+ SQLite（开发）
#  多阶段构建，runtime 仅保留必要依赖
# =================================================================

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# 装构建工具（mysql2 用）
RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# 系统依赖（wget 给 HEALTHCHECK，curl 给 wait-for-mysql）
RUN apk add --no-cache wget curl tini bash

# 创建非 root 用户
RUN addgroup -S app && adduser -S app -G app

# 拷贝生产依赖与源码
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 数据/上传目录可写
RUN mkdir -p /app/data /app/uploads \
    && chown -R app:app /app

USER app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_DIALECT=mysql

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# tini 收 SIGTERM/SIGINT，干净退出
ENTRYPOINT ["/sbin/tini", "--"]
# wait-for-mysql：等 MySQL TCP 通后再启动 Node（避免 Sequelize 启动报错）
CMD ["bash", "-c", "/app/deploy/wait-for-mysql.sh $DB_HOST $DB_PORT && node src/app.js"]
