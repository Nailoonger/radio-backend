#!/bin/bash
# 等 MySQL TCP 端口可连接，超时 60 秒
# 用法：wait-for-mysql.sh <host> <port>

HOST="${1:-mysql}"
PORT="${2:-3306}"
TIMEOUT=60
echo "[wait-for-mysql] 等待 $HOST:$PORT 可连接（最多 ${TIMEOUT}s）..."

for i in $(seq 1 $TIMEOUT); do
  if (echo > /dev/tcp/$HOST/$PORT) 2>/dev/null; then
    echo "[wait-for-mysql] ✅ $HOST:$PORT 已就绪（用时 ${i}s）"
    # 再多等 3 秒，让 MySQL 完成 initdb 脚本
    sleep 3
    exit 0
  fi
  sleep 1
done

echo "[wait-for-mysql] ❌ 超时：$HOST:$PORT 在 ${TIMEOUT}s 内未就绪"
exit 1
