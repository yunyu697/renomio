# Windows 代码签名（OV / EV 均适用）
#
# 用法：
#   # 证书在“当前用户/本机证书存储”里（EV 硬件令牌通常走这里）
#   $env:WINDOWS_CERT_THUMBPRINT = 'A1B2...'
#   powershell -File scripts/sign/windows-sign.ps1 -Files "src-tauri/target/release/renomio.exe","src-tauri/target/release/bundle/nsis/*.exe"
#
#   # 或者 PFX 文件（OV 证书常见；CI 用 secret 注入）
#   $env:WINDOWS_CERT_PFX = 'D:\certs\codesign.pfx'
#   $env:WINDOWS_CERT_PASSWORD = '***'
#   powershell -File scripts/sign/windows-sign.ps1 -Files ...
#
# 没有证书时：打印接入说明并以退出码 3 结束（不会伪造“已签名”）。
# CI 里可加 -Require，让缺证书直接失败。

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Files = @(),
  [string]$Thumbprint = $env:WINDOWS_CERT_THUMBPRINT,
  [string]$PfxPath = $env:WINDOWS_CERT_PFX,
  [string]$PfxPassword = $env:WINDOWS_CERT_PASSWORD,
  [string]$TimestampUrl = $env:WINDOWS_TIMESTAMP_URL,
  [switch]$Require
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($TimestampUrl)) { $TimestampUrl = 'http://timestamp.digicert.com' }

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path $kits) {
    $candidate = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }
  return $null
}

if (-not $Files -or $Files.Count -eq 0) {
  Write-Host '未提供待签名文件。' -ForegroundColor Yellow
  exit 2
}

$signtool = Find-SignTool
if (-not $signtool) {
  Write-Host '未找到 signtool.exe：请安装 Windows SDK（含签名工具）。' -ForegroundColor Yellow
  exit 2
}

$hasThumbprint = -not [string]::IsNullOrWhiteSpace($Thumbprint)
$hasPfx = -not [string]::IsNullOrWhiteSpace($PfxPath) -and (Test-Path $PfxPath)

if (-not $hasThumbprint -and -not $hasPfx) {
  Write-Host ''
  Write-Host '未检测到 Windows 代码签名证书，跳过签名（产物仍可用，但 SmartScreen 会提示未知发布者）。' -ForegroundColor Yellow
  Write-Host '接入点：'
  Write-Host '  OV 证书：导出 .pfx → 设 WINDOWS_CERT_PFX / WINDOWS_CERT_PASSWORD（CI 用 secret）。'
  Write-Host '  EV 证书：证书在硬件令牌 / HSM 中，读取证书指纹后设 WINDOWS_CERT_THUMBPRINT。'
  Write-Host '  Azure Trusted Signing：用 signtool 的 dlib 插件或 Trusted Signing CLI，替换本脚本的 sign 命令。'
  Write-Host '  时间戳服务可用 WINDOWS_TIMESTAMP_URL 覆盖（默认 DigiCert）。'
  Write-Host ''
  if ($Require) { exit 3 }
  exit 0
}

foreach ($file in $Files) {
  $resolved = (Resolve-Path -LiteralPath $file -ErrorAction Stop).Path
  Write-Host "签名：$resolved"
  if ($hasThumbprint) {
    & $signtool sign /fd sha256 /sha1 $Thumbprint /tr $TimestampUrl /td sha256 $resolved
  } else {
    & $signtool sign /fd sha256 /f $PfxPath /p $PfxPassword /tr $TimestampUrl /td sha256 $resolved
  }
  if ($LASTEXITCODE -ne 0) { throw "签名失败：$resolved" }
  & $signtool verify /pa /v $resolved
  if ($LASTEXITCODE -ne 0) { throw "签名校验失败：$resolved" }
}

Write-Host '全部文件签名并通过校验。' -ForegroundColor Green
