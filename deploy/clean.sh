#!/bin/bash
# ⚠️  危险：停止并删除所有容器 + 镜像 + 数据卷
set -e
cd "$(cd "$(dirname "$0")/.." && pwd)"
echo "⚠️  即将删除所有容器、镜像、构建缓存 + ./data/mysql + ./data/uploads"
echo "    该操作不可逆！"
read -p "确认输入 YES 继续: " confirm
if [ "$confirm" != "YES" ]; then
  echo "已取消"
  exit 0
fi
echo "[clean] 清理中..."
docker compose down -v --rmi all --remove-orphans
rm -rf data/mysql data/uploads deploy/certs
echo "✅ 已彻底清理，下次启动会重新 seed 默认数据"
