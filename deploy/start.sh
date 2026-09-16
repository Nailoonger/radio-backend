#!/bin/bash
# 一键启动全栈（Docker Desktop）
# 用法: bash deploy/start.sh

set -e
cd "$(cd "$(dirname "$0")/.." && pwd)"

echo "=========================================="
echo "  菁悠广播站 - 一键启动"
echo "=========================================="

# 1) 检查 docker
if ! command -v docker &> /dev/null; then
  echo "❌ 未找到 docker，请先安装 Docker Desktop"
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker Desktop 未运行，请先启动"
  exit 1
fi

# 2) 生成自签证书（如不存在）
if [ ! -f deploy/certs/server.crt ] || [ ! -f deploy/certs/server.key ]; then
  echo "[1/3] 生成自签证书..."
  bash deploy/gen-selfsigned.sh
else
  echo "[1/3] 自签证书已存在，跳过"
fi

# 3) 创建持久化目录
mkdir -p data/mysql data/uploads
echo "[2/3] 持久化目录就绪（data/mysql + data/uploads）"

# 4) 复制 .env（如不存在）
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "       .env 已从 .env.example 复制（可按需修改）"
fi

# 5) docker compose up
echo "[3/3] 启动容器（首次会构建镜像，耗时较长）..."
docker compose up -d --build

echo ""
echo "=========================================="
echo "  ✅ 启动完成"
echo "=========================================="
echo ""
echo "访问地址："
echo "  管理后台：  https://localhost/"
echo "  Swagger：   https://localhost/api-docs/"
echo "  健康检查：  https://localhost/api/health"
echo ""
echo "默认账号：teacher / admin123456"
echo ""
echo "查看日志：bash deploy/logs.sh"
echo "停止服务：bash deploy/stop.sh"
