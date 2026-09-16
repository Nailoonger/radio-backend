#!/bin/bash
# 查看所有容器日志（实时）
cd "$(cd "$(dirname "$0")/.." && pwd)"
docker compose logs -f --tail=100
