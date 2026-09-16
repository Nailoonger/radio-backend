# ⚠️  危险：停止并删除所有容器 + 镜像 + 数据卷
$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $rootDir

Write-Host "⚠️  即将删除所有容器、镜像、构建缓存 + data/mysql + data/uploads" -ForegroundColor Yellow
Write-Host "    该操作不可逆！" -ForegroundColor Yellow
$confirm = Read-Host "确认输入 YES 继续"
if ($confirm -ne 'YES') {
  Write-Host "已取消"
  exit 0
}

Write-Host "[clean] 清理中..." -ForegroundColor Yellow
docker compose down -v --rmi all --remove-orphans
Remove-Item -Recurse -Force (Join-Path $rootDir 'data/mysql') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $rootDir 'data/uploads') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $rootDir 'deploy/certs') -ErrorAction SilentlyContinue
Write-Host "✅ 已彻底清理" -ForegroundColor Green
