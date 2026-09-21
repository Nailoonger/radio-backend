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
# ⚠️ sqlite3 的预编译二进制默认从 GitHub Releases 下载，国内云服务器普遍超时
#    （超时后回退 node-gyp，而 node:20-alpine 没有 python/make/g++，直接炸）。
#    指到 npmmirror 的二进制镜像：mirror 布局 = {mirror}/v{version}/{文件名}，
#    实测有 sqlite3-v5.1.7-napi-v6-linuxmusl-x64.tar.gz（musl = alpine）。
ENV npm_config_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/sqlite3
# ⚠️ 国内镜像会零星 ECONNRESET（2026-09-21 实测）。npm 默认重试 3 次用尽后，会撞上它自身的
#    "Exit handler never called!" bug —— 关键是这个 bug **以 exit 0 退出**，
#    于是「装了一半的 node_modules」被 BuildKit 当成功层缓存下来，
#    要到下一层 sed mysql2 才炸（报错指向 sed，根因其实在这里，极易误判）。
#    重试次数与退避放大以扛住零星 reset；上限收在 60s/次，免得坏网络下无限拖。
RUN npm ci --omit=dev --no-audit --no-fund \
       --registry=https://mirrors.cloud.tencent.com/npm/ \
       --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000 \
       --fetch-timeout=300000

# 断言依赖真的装全了 —— npm ci 崩溃时 exit 0，只能自己查。
# 用 node 逐个 require.resolve（不用 npm ls --all：它会被 peer 依赖告警误判成失败）。
RUN node -e "const p=require('./package.json');const d=Object.keys(p.dependencies||{});const miss=d.filter(m=>{try{require.resolve(m);return false}catch(e){return true}});if(miss.length){console.error('[FATAL] 缺失生产依赖: '+miss.join(', '));process.exit(1)}console.log('[ok] 生产依赖全部就位: '+d.length+' 个')"
COPY . .

# 永久 patch mysql2 charsets.js：UTF8_GENERAL_CI (33) → UTF8MB4_GENERAL_CI (45)
# 解决 mysql2 v3 + Sequelize 6 的 latin1 bug（写入中文变 EFBFBD）
# test -f 先行：文件不存在 = 上一层依赖装残了（见上），报明确的错；
# grep -q 收尾：断言补丁真的落上了 —— 哪天 mysql2 换了写法，宁可构建失败也别带着 latin1 bug 上线。
RUN test -f node_modules/mysql2/lib/constants/charsets.js \
    && sed -i 's/exports\.UTF8_GENERAL_CI = 33;/exports.UTF8_GENERAL_CI = 45;/' \
         node_modules/mysql2/lib/constants/charsets.js \
    && grep -q 'exports.UTF8_GENERAL_CI = 45;' node_modules/mysql2/lib/constants/charsets.js \
    && echo "✅ mysql2 charsets 已 patch（UTF8_GENERAL_CI=45）"

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
