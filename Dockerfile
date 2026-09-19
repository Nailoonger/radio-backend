# =================================================================
#  菁悠广播站后端 - 生产镜像
#  构建时在容器内 npm ci 安装依赖（跨平台可重建，不依赖主机的 node_modules）
# =================================================================

FROM node:20-alpine
WORKDIR /app

# 创建非 root 用户
RUN addgroup -S app && adduser -S app -G app

# 先拷依赖清单、装依赖（利用层缓存），再拷源码
COPY package*.json ./
RUN npm ci --omit=dev --registry=https://mirrors.cloud.tencent.com/npm/
COPY . .

# 永久 patch mysql2 charsets.js：UTF8_GENERAL_CI (33) → UTF8MB4_GENERAL_CI (45)
# 解决 mysql2 v3 + Sequelize 6 的 latin1 bug（写入中文变 EFBFBD）
RUN sed -i 's/exports\.UTF8_GENERAL_CI = 33;/exports.UTF8_GENERAL_CI = 45;/' \
       node_modules/mysql2/lib/constants/charsets.js

# 数据/上传目录可写
RUN mkdir -p /app/data /app/uploads \
    && chown -R app:app /app

USER app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_DIALECT=mysql

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# wait-for-mysql inline + 启动 Node（用 exec 避免 Windows Node 路径转换问题）
CMD ["node", "src/wait-and-start.js"]
