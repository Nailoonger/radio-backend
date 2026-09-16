# 生成自签 SSL 证书（10 年），用于本地 HTTPS 学习/调试
# 用法: powershell -ExecutionPolicy Bypass -File deploy/gen-selfsigned.ps1
# 需要本机装了 OpenSSL（Git Bash / WSL / 独立安装均可）

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir   = Split-Path -Parent $scriptDir
$certsDir  = Join-Path $rootDir 'deploy/certs'

if (-not (Test-Path $certsDir)) { New-Item -ItemType Directory -Path $certsDir | Out-Null }

$crt = Join-Path $certsDir 'server.crt'
$key = Join-Path $certsDir 'server.key'

if ((Test-Path $crt) -and (Test-Path $key)) {
  Write-Host "证书已存在: $crt"
  Write-Host "如需重新生成，请先删 deploy/certs/server.*"
  exit 0
}

# 自动探测局域网 IP（写入 SAN，让手机扫码也能用）
$localIp = (Get-NetIPAddress -AddressFamily IPv4 `
  | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Hyper-V|vEthernet|WSL' } `
  | Select-Object -First 1).IPAddress

if (-not $localIp) {
  Write-Host "⚠️ 未探测到局域网 IP，仅用 localhost/127.0.0.1"
  $localIp = ''
}

$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
  Write-Host "❌ 未找到 openssl 命令"
  Write-Host "安装方法："
  Write-Host "  - Git for Windows: https://git-scm.com/download/win"
  Write-Host "  - 或 choco install openssl"
  exit 1
}

$subj = "/C=CN/ST=Local/L=Local/O=RadioStation/CN=localhost"
$san  = "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1"
if ($localIp) {
  $san = "$san,IP:$localIp"
}

& $openssl req -x509 -newkey rsa:2048 -nodes -days 3650 `
    -keyout $key -out $crt -subj $subj -addext $san 2>&1 | Out-Null

Write-Host ""
Write-Host "✅ 自签证书已生成："
Write-Host "   证书: $crt"
Write-Host "   私钥: $key"
Write-Host "   域名: localhost + 127.0.0.1" -NoNewline
if ($localIp) { Write-Host " + $localIp" -NoNewline }
Write-Host ""
Write-Host "   有效期: 10 年"
Write-Host ""
Write-Host "⚠️  浏览器会告警「该证书不受信任」，需要手动信任后继续访问。"
