// 在沙箱里演练 install.ps1 / uninstall.ps1 对 profile 的改动：
// 把真实的 cordis.patch.yml 复制到工作区，跑一遍安装 → 卸载 → 再安装，
// 逐步和原文件比对，证明只有我们那两行被增删，其它内容（含 CJK）逐字节不变。
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const pkgDir = 'E:\\dsh\\dsh-plugins\\dsh-fullscreen'
const realProfile = 'C:\\Users\\Richard\\.dsh\\profiles\\desktop'
const sandbox = join(pkgDir, '.probe-profile')
const script = join(pkgDir, 'install.ps1')
const uninstallScript = join(pkgDir, 'uninstall.ps1')
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'node_modules'), { recursive: true })
copyFileSync(join(realProfile, 'cordis.patch.yml'), join(sandbox, 'cordis.patch.yml'))

const original = readFileSync(join(sandbox, 'cordis.patch.yml'))
const originalText = original.toString('utf8')
console.log(`original: ${original.length} bytes, BOM=${original[0] === 0xef}, CRLF=${originalText.includes('\r\n')}, lines=${originalText.split(/\r?\n/).length}`)

const run = (file) => {
  const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Profile', sandbox], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

const show = (label) => {
  const now = readFileSync(join(sandbox, 'cordis.patch.yml'))
  const text = now.toString('utf8')
  const before = original.toString('utf8').split(/\r?\n/)
  const after = text.split(/\r?\n/)
  const added = after.filter((line) => !before.includes(line))
  const removed = before.filter((line) => !after.includes(line))
  console.log(`\n[${label}] ${now.length} bytes, BOM=${now[0] === 0xef}`)
  console.log(`  added   : ${JSON.stringify(added)}`)
  console.log(`  removed : ${JSON.stringify(removed)}`)
  return { added, removed }
}

console.log('\n=== 1st install ===')
console.log(run(script).out.trim())
const first = show('after 1st install')

console.log('\n=== 2nd install (idempotency) ===')
console.log(run(script).out.trim())
const second = show('after 2nd install')

console.log('\n=== uninstall ===')
console.log(run(uninstallScript).out.trim())
const third = show('after uninstall')

console.log('\n=== 3rd install (after uninstall) ===')
console.log(run(script).out.trim())
const fourth = show('after 3rd install')

// 卸载后应该回到原文件的「行集合」（顺序也一样）
const afterUninstallLines = readFileSync(join(sandbox, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
const originalLines = original.toString('utf8').split(/\r?\n/)
console.log('\n=== verdicts ===')
console.log(`install adds exactly the plugin rows   : ${JSON.stringify(first.added) === JSON.stringify(['    - id: dsh-fullscreen', '      name: dsh-fullscreen'])}`)
console.log(`install removes nothing                : ${first.removed.length === 0}`)
console.log(`second install is a no-op              : ${JSON.stringify(second.added) === JSON.stringify(first.added) && second.removed.length === 0}`)
console.log(`uninstall restores the original lines  : ${JSON.stringify(afterUninstallLines) === JSON.stringify(originalLines)}`)
console.log(`third install == first install         : ${JSON.stringify(fourth.added) === JSON.stringify(first.added)}`)

// 顺带确认 npm 能按 profile 的解析规则找到这个包（.probe-profile 里没有 junction，跳过）
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
console.log(`manifest dsh.bundle.patch              : ${manifest.dsh?.bundle?.patch}`)
console.log(`manifest dsh.client.platform           : ${manifest.dsh?.client?.platform}`)
console.log(`manifest exports['./client']           : ${JSON.stringify(manifest.exports?.['./client'])}`)
writeFileSync(join(sandbox, 'ORIGINAL-cordis.patch.yml'), original)
console.log(`\noriginal kept for inspection: ${join(sandbox, 'ORIGINAL-cordis.patch.yml')}`)
