# dsh-fullscreen —— 把插件链进 DSH desktop profile（等价于 plugin_manager install_bundle）
#
# 做的事：
#   1. 在 <profile>\node_modules 下建一个指向本包的 junction（目录联接）；
#   2. 在 <profile>\cordis.patch.yml 末尾追加一行 insert（幂等，已存在则跳过）。
#
# 用法（普通 PowerShell 窗口即可，不需要管理员）：
#   pwsh -File E:\dsh\dsh-plugins\dsh-fullscreen\install.ps1
#
# 只改这两处；卸载见 uninstall.ps1。
param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop"
)

$ErrorActionPreference = 'Stop'

# 脚本自身所在目录 = 本包目录
$PackageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfileDir = (Resolve-Path -LiteralPath $Profile).Path
$NodeModules = Join-Path $ProfileDir 'node_modules'
$LinkPath = Join-Path $NodeModules 'dsh-fullscreen'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $NodeModules)) { throw "profile 里没有 node_modules：$NodeModules" }
if (-not (Test-Path -LiteralPath $PatchPath)) { throw "profile 里没有 cordis.patch.yml：$PatchPath" }

$manifest = Get-Content -LiteralPath (Join-Path $PackageDir 'package.json') -Raw | ConvertFrom-Json

Write-Host "package : $($manifest.name) $($manifest.version)"
Write-Host "profile : $ProfileDir"

# --- 1. junction ------------------------------------------------------------
if (Test-Path -LiteralPath $LinkPath) {
  $existing = Get-Item -LiteralPath $LinkPath
  Write-Host "link    : 已存在（$($existing.LinkType) -> $($existing.Target)），跳过"
} else {
  New-Item -ItemType Junction -Path $LinkPath -Target $PackageDir | Out-Null
  $made = Get-Item -LiteralPath $LinkPath
  Write-Host "link    : 已创建（$($made.LinkType) -> $($made.Target)）"
}

# --- 2. cordis.patch.yml 里的 insert 行 -------------------------------------
# 用 .NET 的 UTF-8（无 BOM）读写：这个文件里有 CJK，PowerShell 5.1 的
# Get-Content/Set-Content 往返会把它变成乱码并加上 BOM。
$utf8 = New-Object System.Text.UTF8Encoding($false)
$lines = [System.IO.File]::ReadAllLines($PatchPath, $utf8)

$already = $false
foreach ($line in $lines) { if ($line -match '^\s*name:\s*''?dsh-fullscreen''?\s*$') { $already = $true } }

if ($already) {
  Write-Host "patch   : 已存在 dsh-fullscreen 行，跳过"
} else {
  # 只往既有 insert 块里**插行**，不重排、不改写任何原有行：一个 YAML 数组里
  # 出现两个 `- insert:` 是重复键，loader 会直接报错，所以必须复用第一个块。
  $insertIndex = -1
  for ($i = 0; $i -lt $lines.Length; $i++) { if ($lines[$i] -match '^- insert:\s*$') { $insertIndex = $i; break } }

  $row = @('    - id: dsh-fullscreen', '      name: dsh-fullscreen')
  if ($insertIndex -ge 0) {
    # 块的末尾 = 最后一个「四空格缩进 + `- `」的行；其后就是下一个顶层条目。
    $lastRow = $insertIndex
    for ($i = $insertIndex + 1; $i -lt $lines.Length; $i++) {
      if ($lines[$i] -match '^    - ') { $lastRow = $i; continue }
      if ($lines[$i] -match '^\s*$' -or $lines[$i] -match '^      ') { continue }
      break
    }
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -le $lastRow; $i++) { $out.Add($lines[$i]) }
    foreach ($added in $row) { $out.Add($added) }
    for ($i = $lastRow + 1; $i -lt $lines.Length; $i++) { $out.Add($lines[$i]) }
    [System.IO.File]::WriteAllLines($PatchPath, $out.ToArray(), $utf8)
    Write-Host "patch   : 已在第 $($insertIndex + 1) 行的 insert 块里追加 dsh-fullscreen"
  } else {
    [System.IO.File]::WriteAllLines($PatchPath, ([string[]]($lines + @('', '- insert:', '    - id: dsh-fullscreen', '      name: dsh-fullscreen'))), $utf8)
    Write-Host "patch   : 已追加新的 insert 块"
  }
}

Write-Host ''
Write-Host '完成。重启 DSH 桌面端（完全退出后重新打开）即可生效；'
Write-Host '之后按 F11（macOS 为 Control+Command+F）切换全屏。'
