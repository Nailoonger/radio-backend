# 停止全栈（保留数据）
$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $rootDir
Write-Host "[stop] 停止容器（保留 data）..."
docker compose down
Write-Host "✅ 已停止"
