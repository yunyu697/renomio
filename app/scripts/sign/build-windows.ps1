# Windows 发布构建（NSIS 安装包 + 主程序），可选签名。
#
# 用法：
#   powershell -File scripts/sign/build-windows.ps1                # 未签名构建（发版前会警告）
#   powershell -File scripts/sign/build-windows.ps1 -Sign           # 有证书则签名
#   powershell -File scripts/sign/build-windows.ps1 -Sign -RequireSign  # CI：缺证书直接失败

param(
  [switch]$Sign,
  [switch]$RequireSign
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $root
try {
  Write-Host "构建目录：$root"
  npm run tauri build -- --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }

  $release = Join-Path $root 'src-tauri\target\release'
  $exe = Join-Path $release 'renomio.exe'
  if (-not (Test-Path $exe)) { $exe = Join-Path $release 'Renomio.exe' }
  $installers = Get-ChildItem (Join-Path $release 'bundle\nsis') -Filter *.exe -ErrorAction SilentlyContinue

  $artifacts = @()
  if (Test-Path $exe) { $artifacts += (Resolve-Path $exe).Path }
  foreach ($i in $installers) { $artifacts += $i.FullName }

  if (-not $artifacts) { throw '未找到构建产物，请检查 tauri build 输出' }

  if ($Sign -or $env:WINDOWS_CERT_THUMBPRINT -or $env:WINDOWS_CERT_PFX) {
    $signArgs = @('-Files') + $artifacts
    if ($RequireSign) { $signArgs += '-Require' }
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows-sign.ps1') @signArgs
    if ($LASTEXITCODE -ne 0) {
      if ($RequireSign) { throw "签名失败（退出码 $LASTEXITCODE）" }
      Write-Host '签名未完成，继续输出未签名产物。' -ForegroundColor Yellow
    }
  } else {
    Write-Host '提示：本次未签名。加 -Sign 并在环境中提供证书后重新构建。' -ForegroundColor Yellow
  }

  Write-Host ''
  Write-Host '产物：'
  foreach ($a in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 $a).Hash
    Write-Host "  $a"
    Write-Host "    SHA256 $hash"
  }
} finally {
  Pop-Location
}
