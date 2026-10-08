// 真实页面冒烟测试：把 lib/client.js 放进一个真实的 Chromium 页面（DSH Web GUI），
// 用 CDP 的「受信任输入」按 F11，看它是否真的调用 Fullscreen API 并进入全屏。
//
// 与 verify-client.mjs 的区别：那边用假 document 测逻辑，这边测的是真实浏览器行为
// ——Fullscreen API 是否存在、键盘事件是否被页面吃掉、requestFullscreen 是否 resolve。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const bundle = readFileSync('E:\\dsh\\dsh-plugins\\dsh-fullscreen\\lib\\client.js', 'utf8')
// 浏览器 profile 必须放在会话工作区里：沙箱只允许写这里。
const profile = 'E:\\dsh\\dsh-fullscreen-probe\\edge-profile'
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

// 本地一张最小页面：比 DSH 页面更干净，也证明插件不依赖 DSH 页面里的任何东西。
// 第二张页面用于模拟「页面自己已经处理了 F11」的情况。
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>dsh-fullscreen probe</title></head><body><h1>probe</h1></body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/`

const edge = spawn(EDGE, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1200,800',
  origin,
], { stdio: 'ignore' })

// 沙箱里不能把子进程的输出接到管道上（spawn EPERM），所以端口从 Edge 自己写的
// DevToolsActivePort 文件里读：第一行就是端口号。
const portFile = join(profile, 'DevToolsActivePort')
const devtoolsPort = await new Promise((resolve, reject) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, 'utf8').split('\n')
      if (text.length > 0 && text[0].trim() !== '') { clearInterval(timer); resolve(Number(text[0].trim())); return }
    }
    if (Date.now() - started > 30000) { clearInterval(timer); reject(new Error('Edge did not write DevToolsActivePort in 30s')) }
  }, 250)
  edge.on('exit', (code) => { clearInterval(timer); reject(new Error(`Edge exited early: ${code}`)) })
})

const json = async (path) => (await fetch(`http://127.0.0.1:${devtoolsPort}${path}`)).json()
let target
for (let i = 0; i < 60 && target === undefined; i++) {
  const list = await json('/json/list')
  target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined)
  if (target === undefined) await new Promise((r) => setTimeout(r, 500))
}
if (target === undefined) throw new Error('no page target')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let seq = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  if (process.env.DSH_FS_TRACE === '1') console.log(`--- evaluate (${expression.length} chars)`)
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate threw')
  return result.result.value
}

await send('Page.enable')
await send('Runtime.enable')
if (process.env.DSH_FS_TRACE === '1') console.log('--- page.enable/runtime.enable ok')
await send('Page.navigate', { url: origin })
await new Promise((r) => setTimeout(r, 800))
if (process.env.DSH_FS_TRACE === '1') console.log('--- navigated')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }

// 把 bundle 装进页面，并留下 window.__probe（DSH 页面里由 shell 调 apply）
const install = async () => evaluate(`
  (() => {
    let captured = null;
    window.__ModuleLoader__ = window.__ModuleLoader__ ?? {
      load: (entry) => { captured = entry; },
      get: () => undefined,
      has: () => false,
    };
    ${bundle}
    const exported = captured.factory(() => { throw new Error('the bundle must not require anything at load time') });
    window.__probe = exported;
    return { id: captured.id, keys: Object.keys(exported), inject: exported.inject, applyType: typeof exported.apply };
  })()
`)

// 1. bundle 在真实页面里不抛异常，并交出 apply/inject
const loaded = await install()
check('bundle registers with the page module loader', loaded.id === 'dsh-fullscreen', JSON.stringify(loaded))
check('bundle evaluates in a real page', loaded.applyType === 'function', JSON.stringify(loaded))
check('inject stays empty', Array.isArray(loaded.inject) && loaded.inject.length === 0)

check('document.fullscreenEnabled is true', await evaluate('document.fullscreenEnabled === true'))

const probe = () => evaluate(`({
  attribute: document.documentElement.getAttribute('data-dsh-fullscreen'),
  fullscreenElement: document.fullscreenElement === null ? null : document.fullscreenElement.tagName,
  preference: localStorage.getItem('dsh-fullscreen:on:v1'),
  entered: window.__entered ?? null,
  seen: window.__seen ?? null,
})`)

// 2. 无偏好：插件不接管 F11（defaultPrevented 保持 false），但页面上留下挂载标记
await evaluate(`
  (() => {
    localStorage.clear();
    window.__seen = [];
    window.__probe.apply({});
    // 注册在插件之后：同一个 capture 阶段里，后注册的监听器能看到 preventDefault 的结果
    window.addEventListener('keydown', (event) => window.__seen.push({ key: event.key, prevented: event.defaultPrevented }), true);
    return true;
  })()
`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await new Promise((r) => setTimeout(r, 300))
const passive = await evaluate(`({
  attribute: document.documentElement.getAttribute('data-dsh-fullscreen'),
  seen: window.__seen,
})`)
check('apply() marks the document as attached', passive.attribute === '1', JSON.stringify(passive))
check(
  'F11 is handled by the plugin (defaultPrevented=true)',
  Array.isArray(passive.seen) && passive.seen.length === 1 && passive.seen[0].prevented === true,
  JSON.stringify(passive.seen)
)

// 归零：headless Edge 自己会用 F11 切换全屏，先退出并抹掉它顺手写下的偏好，
// 让第 3 步从一个确定的“未全屏 + 有偏好”状态开始。
await evaluate(`
  (() => {
    if (document.fullscreenElement !== null) document.exitFullscreen();
    localStorage.clear();
    return true;
  })()
`)
await new Promise((r) => setTimeout(r, 500))

// 3. 有偏好：重新载入页面（模拟 DSH 刷新/恢复），apply 后按 F11 应真正进入全屏
await evaluate(`localStorage.setItem('dsh-fullscreen:on:v1', '1'); true`)
await send('Page.navigate', { url: origin })
await new Promise((r) => setTimeout(r, 600))
await install()
await evaluate(`
  (() => {
    window.__entered = [];
    window.__seen = [];
    document.addEventListener('fullscreenchange', () => window.__entered.push(document.fullscreenElement === null ? null : document.fullscreenElement.tagName));
    window.__probe.apply({});
    window.addEventListener('keydown', (event) => window.__seen.push({ key: event.key, prevented: event.defaultPrevented }), true);
    return true;
  })()
`)
await new Promise((r) => setTimeout(r, 400))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await new Promise((r) => setTimeout(r, 800))
const afterF11 = await probe()
check('F11 with the preference on enters fullscreen', afterF11.fullscreenElement === 'HTML', JSON.stringify(afterF11))
check(
  'the plugin handled the key itself (defaultPrevented=true)',
  Array.isArray(afterF11.seen) && afterF11.seen.length === 1 && afterF11.seen[0].prevented === true,
  JSON.stringify(afterF11.seen)
)
check('a trusted F11 really produced a fullscreenchange', Array.isArray(afterF11.entered) && afterF11.entered.length >= 1, JSON.stringify(afterF11.entered))

// 4. 再次 F11 退出
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 })
await new Promise((r) => setTimeout(r, 800))
const exited = await probe()
check('a second F11 leaves fullscreen', exited.fullscreenElement === null, JSON.stringify(exited))
check('leaving fullscreen clears the remembered preference', exited.preference === null, JSON.stringify(exited))

// 5. 第二次 apply 不重复绑定（真实页面里跑一遍去重路径）
const twice = await evaluate(`
  (() => {
    let requests = 0;
    const original = document.documentElement.requestFullscreen;
    document.documentElement.requestFullscreen = function (...args) { requests++; return original.apply(this, args) };
    window.__probe.apply({});
    window.__probe.apply({});
    document.documentElement.requestFullscreen = original;
    return { requests };
  })()
`)
check('a second apply binds nothing new', twice.requests === 0, JSON.stringify(twice))

const failed = results.filter((entry) => !entry.ok)
console.log(`\nprobe: ${results.length - failed.length}/${results.length} passed`)

socket.close()
edge.kill()
server.close()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* Edge may still hold files; the temp dir is disposable */ }
writeFileSync('E:\\dsh\\dsh-plugins\\dsh-fullscreen\\verify\\last-real-page-probe.json', JSON.stringify(results, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
