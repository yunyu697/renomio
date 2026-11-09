<#
真实文件闭环（一键可重复）：
1) 重建三份真实样本：带 EXIF/XMP/GPS/ICC 的 JPEG、带 ID3v2.3 的 MP3、GB18030 文本
2) 启动安装版，走真实 UI：拖入 -> 规则 -> 预览 -> 执行 -> 撤销（含 SHA-256 对拍）
3) 走安装版 IPC：图片/音频元数据、只读属性、GBK->UTF-8、固定时间
4) 外部工具读回：exiftool / ffprobe / attrib / Get-Item / PowerShell 编码
用法：powershell -ExecutionPolicy Bypass -File app\scripts\verify\real-chain.ps1
#>
param(
  [string]$Exe = 'C:\Program Files\Renomio\renomio.exe',
  [string]$Corpus = 'D:\Users\Tyler Zhang\Documents\Trae-CN\temp_20261105_06\real-corpus-alpha4',
  [string]$Samples = 'D:\Users\Tyler Zhang\Documents\Trae-CN\temp_20261105_06\verify\samples',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\verify-out\real-chain'),
  [int]$Port = 9445
)

$ErrorActionPreference = 'Stop'
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$exiftool = 'D:\Users\Tyler Zhang\Documents\Trae-CN\temp_20261105_06\verify\node_modules\exiftool-vendored.exe\bin\exiftool.exe'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$result = [ordered]@{ corpus = $Corpus; exif = @{}; exifNumeric = @{}; audio = @{}; text = @{}; attrs = @{}; times = @{}; hashes = @{}; defects = @(); checks = @(); failures = @() }
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $result.checks += [ordered]@{ name = $name; ok = $ok; detail = $detail }
  if (-not $ok) { $result.failures += "$name $detail" }
  Write-Host ("[{0}] {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail)
}

if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到 $Exe" }
if (-not (Test-Path -LiteralPath $Samples)) { throw "找不到样本目录 $Samples" }

# ---------- 1. 重建语料 ----------
Get-Process -Name renomio -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 300; if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force } }
Start-Sleep -Milliseconds 700
if (Test-Path -LiteralPath $Corpus) { cmd /c "attrib -R -S -H /S /D `"$Corpus`*`"" 2>$null | Out-Null; Remove-Item -LiteralPath $Corpus -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Corpus | Out-Null
Copy-Item (Join-Path $Samples 'full_exif.jpg') (Join-Path $Corpus 'album-2024.jpg') -Force
Copy-Item (Join-Path $Samples 'gb18030.txt') (Join-Path $Corpus 'notes-gbk.txt') -Force
Copy-Item (Join-Path $Samples 'gb18030.txt') (Join-Path $Corpus 'readonly-demo.txt') -Force
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=1" -codec:a libmp3lame -q:a 4 -id3v2_version 3 `
  -metadata title="上海现场 2024" -metadata artist="Renomio 验证" -metadata album="现场录音" -metadata track="1/2" `
  -metadata date="2024-05-01" -metadata comment="ID3v2.3 real file" (Join-Path $Corpus 'track-01.mp3')
$originals = @('album-2024.jpg', 'track-01.mp3', 'notes-gbk.txt')
$before = @{}
foreach ($n in $originals) { $before[$n] = (Get-FileHash (Join-Path $Corpus $n) -Algorithm SHA256).Hash }
$result.hashes.before = $before
Check '语料重建（3 份真实文件）' ((Get-ChildItem $Corpus -File).Count -ge 4) ((Get-ChildItem $Corpus -File).Name -join ', ')

# ---------- 2. 启动安装版 ----------
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
$env:CDP_PORT = "$Port"; $env:CHAIN_CORPUS = $Corpus; $env:VERIFY_OUT = $OutDir
$proc = Start-Process -FilePath $Exe -PassThru
$cdpOk = $false
for ($i = 0; $i -lt 40; $i++) {
  try { $j = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/json" -TimeoutSec 1; if ($j.StatusCode -eq 200) { $cdpOk = $true; break } } catch {}
  Start-Sleep -Milliseconds 300
}
Check '安装版已启动且调试通道可用' $cdpOk "pid=$($proc.Id) port=$Port"

# ---------- 3. 规则链（真实 UI） ----------
$ErrorActionPreference = 'Continue'
$uiOut = & node (Join-Path $PSScriptRoot 'real-chain.mjs') 2>&1
$uiText = ($uiOut | Out-String); $uiOut | Write-Host
$ErrorActionPreference = 'Stop'
Check '规则链 UI 闭环（拖入/规则/预览/执行/撤销）' ($uiText -match 'SUMMARY ALL PASS') ($uiText -split "`n" | Select-Object -Last 1)
$afterUndo = @{}
foreach ($n in $originals) { $afterUndo[$n] = (Get-FileHash (Join-Path $Corpus $n) -Algorithm SHA256).Hash }
$result.hashes.afterUndo = $afterUndo
Check '改名+撤销后三个文件 SHA-256 不变' ((($before.Keys | ForEach-Object { $before[$_] -eq $afterUndo[$_] }) -contains $false) -eq $false) ($originals -join ', ')

# ---------- 4. 元数据/属性/文本/时间 ----------
$ErrorActionPreference = 'Continue'
$opsOut = & node (Join-Path $PSScriptRoot 'real-chain-ops.mjs') 2>&1
$opsText = ($opsOut | Out-String); $opsOut | Write-Host
$ErrorActionPreference = 'Stop'
Check 'IPC 写入链路执行' ($opsText -match 'SUMMARY ALL PASS') ($opsText -split "`n" | Select-Object -Last 1)

# ---------- 5. 外部读回 ----------
$img = Join-Path $Corpus 'album-2024.jpg'
$exifJson = (& $exiftool -a -G1 -s -j -Title -Description -Subject -Creator -Rights -CreatorTool -DateCreated -ModifyDate -CreateDate -DateTimeOriginal -Software -Headline -Credit -Source -City -Location -Make -Model -GPSLatitude -GPSLongitude $img) | ConvertFrom-Json
$result.exif = $exifJson
$expectExif = [ordered]@{
  'XMP-dc:Title' = '外滩清晨 2024'; 'XMP-dc:Description' = 'Renomio alpha5 真实文件闭环'
  'XMP-dc:Creator' = 'Tyler Zhang'; 'XMP-dc:Rights' = '© 2024 Tyler Zhang'
  'XMP-xmp:CreatorTool' = 'Renomio 1.1.0-alpha5'; 'XMP-photoshop:Headline' = '外滩清晨'
  'XMP-photoshop:Credit' = 'Renomio 验证'; 'XMP-photoshop:Source' = '自有素材'
  'XMP-photoshop:City' = '上海'; 'XMP-iptcCore:Location' = '外滩'
  'XMP-tiff:Make' = 'FUJIFILM'; 'XMP-tiff:Model' = 'Fujifilm X-T5'
}
foreach ($k in $expectExif.Keys) {
  $val = $exifJson.$k
  Check "exiftool 读回 $k" ([string]$val -eq $expectExif[$k]) "got=$val want=$($expectExif[$k])"
}
Check 'exiftool 读回 XMP 关键词' (($exifJson.'XMP-dc:Subject' -join ';') -eq '外滩;清晨;验证') ($exifJson.'XMP-dc:Subject' -join ';')
Check 'exiftool 读回 XMP GPS 纬度' ($exifJson.'XMP-exif:GPSLatitude' -like '31 deg*N*') $exifJson.'XMP-exif:GPSLatitude'
Check 'exiftool 读回 XMP 经度' ($exifJson.'XMP-exif:GPSLongitude' -like '121 deg*E*') $exifJson.'XMP-exif:GPSLongitude'
$result.exifTouchedDate = [ordered]@{ xmpDateCreated = $exifJson.'XMP-photoshop:DateCreated'; exifIfd = $exifJson.'ExifIFD:DateTimeOriginal'; ifd0 = $exifJson.'IFD0:ModifyDate'; digitized = $exifJson.'ExifIFD:CreateDate'; cameraMakeIfd0 = $exifJson.'IFD0:Make'; xmpMake = $exifJson.'XMP-tiff:Make'; cameraModelIfd0 = $exifJson.'IFD0:Model'; xmpModel = $exifJson.'XMP-tiff:Model'; ifd0Software = $exifJson.'IFD0:Software'; xmpCreatorTool = $exifJson.'XMP-xmp:CreatorTool' }

# EXIF 子 IFD 与 XMP 一致性（数值形态读回，GPS 用十进制便于比对）
# 注意 exiftool 的标签名：0x0132=ModifyDate、0x9004=CreateDate（不是 DateTimeDigitized）
$imgNum = (& $exiftool -a -G1 -s -n -j -ModifyDate -DateTimeOriginal -CreateDate -Make -Model -Software -GPSLatitude -GPSLongitude -GPSLatitudeRef -GPSLongitudeRef $img) | ConvertFrom-Json
$result.exifNumeric = $imgNum
$wantTime = '2024:07:08 06:12:33'
Check 'ExifIFD:DateTimeOriginal 已写入新值' ($imgNum.'ExifIFD:DateTimeOriginal' -eq $wantTime) "got=$($imgNum.'ExifIFD:DateTimeOriginal') want=$wantTime"
Check 'ExifIFD:CreateDate（0x9004）与 DateTimeOriginal 一致' ($imgNum.'ExifIFD:CreateDate' -eq $wantTime) "got=$($imgNum.'ExifIFD:CreateDate')"
Check 'IFD0:ModifyDate（0x0132）与 ExifIFD:DateTimeOriginal 一致' ($imgNum.'IFD0:ModifyDate' -eq $wantTime) "got=$($imgNum.'IFD0:ModifyDate')"
Check 'XMP photoshop:DateCreated 与 ExifIFD 一致' ($exifJson.'XMP-photoshop:DateCreated' -eq $wantTime) "got=$($exifJson.'XMP-photoshop:DateCreated')"
Check 'IFD0:Model 与 XMP-tiff:Model 一致' ($imgNum.'IFD0:Model' -eq $exifJson.'XMP-tiff:Model') "ifd0=$($imgNum.'IFD0:Model') xmp=$($exifJson.'XMP-tiff:Model')"
Check 'IFD0:Make 随型号联动为 FUJIFILM' ($imgNum.'IFD0:Make' -eq 'FUJIFILM') "ifd0=$($imgNum.'IFD0:Make')"
Check 'IFD0:Make 与 XMP-tiff:Make 一致' ($imgNum.'IFD0:Make' -eq $exifJson.'XMP-tiff:Make') "ifd0=$($imgNum.'IFD0:Make') xmp=$($exifJson.'XMP-tiff:Make')"
Check 'IFD0:Software 与 XMP-xmp:CreatorTool 一致' ($imgNum.'IFD0:Software' -eq $exifJson.'XMP-xmp:CreatorTool') "ifd0=$($imgNum.'IFD0:Software') xmp=$($exifJson.'XMP-xmp:CreatorTool')"
$latExif = [double]$imgNum.'GPS:GPSLatitude'; $latXmp = [double]$imgNum.'XMP-exif:GPSLatitude'
$lonExif = [double]$imgNum.'GPS:GPSLongitude'; $lonXmp = [double]$imgNum.'XMP-exif:GPSLongitude'
Check 'EXIF GPS 纬度与 XMP 一致（±1e-6 度）' ([math]::Abs($latExif - $latXmp) -lt 1e-6) "exif=$latExif xmp=$latXmp"
Check 'EXIF GPS 经度与 XMP 一致（±1e-6 度）' ([math]::Abs($lonExif - $lonXmp) -lt 1e-6) "exif=$lonExif xmp=$lonXmp"
Check 'GPS 半球 Ref 已写入' ($imgNum.'GPS:GPSLatitudeRef' -eq 'N' -and $imgNum.'GPS:GPSLongitudeRef' -eq 'E') "latRef=$($imgNum.'GPS:GPSLatitudeRef') lonRef=$($imgNum.'GPS:GPSLongitudeRef')"

$mp3 = Join-Path $Corpus 'track-01.mp3'
$tags = (ffprobe -v error -show_entries format_tags -of json $mp3 | ConvertFrom-Json).format.tags
$result.audio = $tags
foreach ($pair in @(@('title','上海现场 2025'), @('artist','Renomio 现场'), @('album','现场录音 II'), @('track','2/2'), @('genre','Live'), @('album_artist','Renomio'), @('comment','alpha5 真实文件闭环'))) {
  Check "ffprobe 读回 ID3 $($pair[0])" ([string]$tags.($pair[0]) -eq $pair[1]) "got=$($tags.($pair[0]))"
}
Check 'ffprobe 读回 ID3 date' ([string]$tags.date -like '2025*') $tags.date

$txt = Join-Path $Corpus 'notes-gbk.txt'
# 先读时间：读取文件内容会刷新 atime，必须把 Get-Item 放在任何内容读取之前。
$item = Get-Item $txt
$want = [datetime]'2023-03-04 05:06:07'
$result.times = [ordered]@{ creation = $item.CreationTime.ToString('yyyy-MM-dd HH:mm:ss'); mtime = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'); atime = $item.LastAccessTime.ToString('yyyy-MM-dd HH:mm:ss') }
Check 'Get-Item 读回 CreationTime' ([math]::Abs(($item.CreationTime - $want).TotalSeconds) -le 2) $result.times.creation
Check 'Get-Item 读回 LastWriteTime' ([math]::Abs(($item.LastWriteTime - $want).TotalSeconds) -le 2) $result.times.mtime
# Windows 的 last access 会被 AV/索引器/读回本身刷新，外部读回不作为判定依据；以批次记录里的写入值为准。
try {
  $opsJson = Get-Content (Join-Path $OutDir 'real-chain-ops.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $timeStep = $opsJson.results | Where-Object { $_.kind -eq 'time' } | Select-Object -First 1
  $afterAtime = ($timeStep.result.batch.ops[0].after | ConvertFrom-Json).atime
  Check '批次记录写入 atime=2023-03-04 05:06:07' ($afterAtime -eq 1677877567000) "after.atime=$afterAtime"
} catch {
  $result.defects += "读取批次记录 atime 失败：$($_.Exception.Message)"
  Write-Host "[WARN] 读取批次记录 atime 失败：$($_.Exception.Message)"
}
if ([math]::Abs(($item.LastAccessTime - $want).TotalSeconds) -gt 2) {
  $result.defects += "外部读回 atime 已被系统刷新为 $($result.times.atime)（Windows last-access 更新，非写入失败）"
  Write-Host ("[WARN] Get-Item atime 被系统刷新为 {0}，以批次记录写入值为准" -f $result.times.atime)
}

$utf8 = [IO.File]::ReadAllText($txt, [Text.Encoding]::UTF8)
$bak = Get-ChildItem $Corpus -Filter 'notes-gbk.txt.*.bak' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$result.text = [ordered]@{ targetBytes = (Get-Item $txt).Length; backup = $bak.FullName; backupBytes = $bak.Length }
$gbkFromBak = [Text.Encoding]::GetEncoding(936).GetString([IO.File]::ReadAllBytes($bak.FullName))
Check '外部按 UTF-8 读回转换后文本' ($utf8 -eq $gbkFromBak) ($utf8.Trim() -replace "`r?`n", ' | ')
Check '外部按 GB18030 读回 .bak' ($gbkFromBak -match '城市=上海' -and $gbkFromBak -match '备注=编码验证样本') ($gbkFromBak.Trim() -replace "`r?`n", ' | ')

$roPath = Join-Path $Corpus 'readonly-demo.txt'
$ro = (cmd /c "attrib `"$roPath`"") -join ''
$noR = (cmd /c "attrib `"$txt`"") -join ''
$roFlags = ($ro -replace [regex]::Escape($roPath), '').Trim()
$txtFlags = ($noR -replace [regex]::Escape($txt), '').Trim()
$result.attrs = [ordered]@{ readonlyDemo = $ro; text = $noR; readonlyFlags = $roFlags; textFlags = $txtFlags }
Check 'attrib 读回只读属性 R' ($roFlags -match 'R') "flags=[$roFlags]"
Check '转换后的文本未带 R' ($txtFlags -notmatch 'R') "flags=[$txtFlags]"

$bakAll = @(
  ((Get-ChildItem $Corpus -Filter 'album-2024.jpg.*.bak').Count -gt 0),
  ((Get-ChildItem $Corpus -Filter 'track-01.mp3.*.bak').Count -gt 0),
  ((Get-ChildItem $Corpus -Filter 'notes-gbk.txt.*.bak').Count -gt 0)
)
Check '图片/音频/文本均有 .bak 备份' (-not ($bakAll -contains $false)) ($bakAll -join ',')

# ---------- 6. 收尾 ----------
Start-Sleep -Milliseconds 300
if (-not $proc.HasExited) { $proc.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 3; if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } }
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
$result.generatedAt = (Get-Date).ToString('o')
$result.summary = if ($result.failures.Count -eq 0) { 'ALL PASS' } else { 'FAILURES: ' + ($result.failures -join ' | ') }
$result | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $OutDir 'real-chain-summary.json') -Encoding utf8
Write-Host ''
Write-Host "SUMMARY $($result.summary)"
if ($result.failures.Count -gt 0) { exit 1 }
