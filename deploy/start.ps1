# 一键启动全栈（Docker Desktop）
# 用法：powershell -ExecutionPolicy Bypass -File deploy/start.ps1

$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $rootDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  菁悠广播站 - 一键启动" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1) 检查 docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "❌ 未找到 docker，请先安装 Docker Desktop" -ForegroundColor Red
  exit 1
}
try { docker info | Out-Null } catch {
  Write-Host "❌ Docker Desktop 未运行，请先启动" -ForegroundColor Red
  exit 1
}

# 2) 生成自签证书（如不存在）
$crt = Join-Path $rootDir 'deploy/certs/server.crt'
$key = Join-Path $rootDir 'deploy/certs/server.key'
if ((-not (Test-Path $crt)) -or (-not (Test-Path $key))) {
  Write-Host "[1/3] 生成自签证书..." -ForegroundColor Yellow
  & powershell -ExecutionPolicy Bypass -File (Join-Path $rootDir 'deploy/gen-selfsigned.ps1')
} else {
  Write-Host "[1/3] 自签证书已存在，跳过"
}

# 3) 创建持久化目录
New-Item -ItemType Directory -Path (Join-Path $rootDir 'data/mysql') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $rootDir 'data/uploads') -Force | Out-Null
Write-Host "[2/3] 持久化目录就绪"

# 4) .env
if ((-not (Test-Path (Join-Path $rootDir '.env'))) -and (Test-Path (Join-Path $rootDir '.env.example'))) {
  Copy-Item (Join-Path $rootDir '.env.example') (Join-Path $rootDir '.env')
  Write-Host "       .env 已从 .env.example 复制"
}

# 5) docker compose up
Write-Host "[3/3] 启动容器（首次构建镜像耗时较长）..." -ForegroundColor Yellow
docker compose up -d --build

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  ✅ 启动完成" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "访问地址："
Write-Host "  管理后台：  https://localhost/"
Write-Host "  Swagger：   https://localhost/api-docs/"
Write-Host "  健康检查：  https://localhost/api/health"
Write-Host ""
Write-Host "默认账号：teacher / admin123456"
Write-Host ""
$logScript = Join-Path $PSScriptRoot 'logs.ps1'
$stopScript = Join-Path $PSScriptRoot 'stop.ps1'
Write-Host ("查看日志：powershell -File " + $logScript)
Write-Host ("停止服务：powershell -File " + $stopScript)
