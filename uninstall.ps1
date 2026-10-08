# dsh-fullscreen —— 从 DSH desktop profile 里卸载
#
# 做的事（install.ps1 的逆操作，两者都只碰自己写的那两处）：
#   1. 删掉 <profile>\node_modules\dsh-fullscreen 这个 junction（只删链接，不动本包）；
#   2. 从 <profile>\cordis.patch.yml 里删掉 dsh-fullscreen 那两行。
#
# 用法：
#   pwsh -File E:\dsh\dsh-plugins\dsh-fullscreen\uninstall.ps1
param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop"
)

$ErrorActionPreference = 'Stop'

$ProfileDir = (Resolve-Path -LiteralPath $Profile).Path
$LinkPath = Join-Path $ProfileDir 'node_modules\dsh-fullscreen'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

if (Test-Path -LiteralPath $LinkPath) {
  $item = Get-Item -LiteralPath $LinkPath -Force
  # 只删链接：目标是用户的包目录（可能在 E:\dsh 下），不能被递归删除。
  if ($item.LinkType -ne $null) {
    [System.IO.Directory]::Delete($LinkPath, $false)
    Write-Host "link    : 已删除 junction（目标 $($item.Target) 保持不动）"
  } else {
    throw "$LinkPath 不是链接而是一个真实目录，拒绝删除。请手工确认后处理。"
  }
} else {
  Write-Host 'link    : 不存在，跳过'
}

# 同样走 .NET UTF-8（无 BOM）：这个文件里有 CJK。
$utf8 = New-Object System.Text.UTF8Encoding($false)
$lines = [System.IO.File]::ReadAllLines($PatchPath, $utf8)
$kept = New-Object System.Collections.Generic.List[string]
$removed = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*- id:\s*''?dsh-fullscreen''?\s*$') {
    $removed++
    # 紧跟其后的 `name:` 行也是本插件的一部分。
    if ($i + 1 -lt $lines.Length -and $lines[$i + 1] -match '^\s*name:\s*''?dsh-fullscreen''?\s*$') { $i++ }
    continue
  }
  $kept.Add($lines[$i])
}
if ($removed -gt 0) {
  [System.IO.File]::WriteAllLines($PatchPath, $kept.ToArray(), $utf8)
  Write-Host "patch   : 已删除 $removed 处 dsh-fullscreen 声明"
} else {
  Write-Host 'patch   : 没有 dsh-fullscreen 声明，跳过'
}

Write-Host ''
Write-Host '完成。重启 DSH 桌面端后生效。'
