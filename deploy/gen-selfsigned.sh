#!/bin/bash
# 生成自签 SSL 证书（10 年），用于本地 HTTPS 学习/调试
# 用法: bash deploy/gen-selfsigned.sh [domain]
# 默认域名 localhost + 局域网 IP 占位

set -e
DOMAIN="${1:-localhost}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy/certs"
mkdir -p "$DIR"

if [ -f "$DIR/server.crt" ] && [ -f "$DIR/server.key" ]; then
  echo "证书已存在: $DIR/server.crt"
  echo "如需重新生成，请先删 deploy/certs/server.*"
  exit 0
fi

# 自动添加本机局域网 IP 到 SAN（让手机扫码能用）
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo "")

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/server.key" \
  -out    "$DIR/server.crt" \
  -subj   "/C=CN/ST=Local/L=Local/O=RadioStation/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1${LOCAL_IP:+,IP:$LOCAL_IP}" 2>&1 | tail -5

echo ""
echo "✅ 自签证书已生成："
echo "   证书: $DIR/server.crt"
echo "   私钥: $DIR/server.key"
echo "   域名: $DOMAIN + localhost + 127.0.0.1${LOCAL_IP:+ + $LOCAL_IP}"
echo "   有效期: 10 年"
echo ""
echo "⚠️  浏览器会告警「该证书不受信任」，需要手动信任后继续访问。"
