# 查看所有容器日志（实时）
$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $rootDir
docker compose logs -f --tail=100
