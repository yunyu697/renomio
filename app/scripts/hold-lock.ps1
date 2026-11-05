# 持有一个独占文件句柄，用于验证“被占用 / 锁定文件”场景。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/hold-lock.ps1 -Seconds 90
# 期间到应用里尝试更名该文件：执行应失败并保留源文件，批次日志记录失败原因。
param(
  [string]$Path = (Join-Path $PSScriptRoot '..\test-corpus\被占用-锁定.docx'),
  [int]$Seconds = 90
)

$resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
$stream = [System.IO.File]::Open($resolved, 'Open', 'ReadWrite', 'None')
try {
  Write-Host "已锁定：$resolved（$Seconds 秒后自动释放，Ctrl+C 可提前结束）"
  Start-Sleep -Seconds $Seconds
} finally {
  $stream.Close()
  Write-Host '已释放锁。'
}
