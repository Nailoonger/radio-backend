#!/bin/bash
# 停止全栈（保留数据）
set -e
cd "$(cd "$(dirname "$0")/.." && pwd)"
echo "[stop] 停止容器（保留 ./data/mysql 和 ./data/uploads）..."
docker compose down
echo "✅ 已停止"
