// Offline suite for the browser half of dsh-fullscreen.
//
// It runs the REAL built bundle — the loader wrapper and all — against a stub
// DOM, because every route in this package is a page-level behaviour that a grep
// would happily pass on an implementation that ignores it: whether F11 toggles,
// whether a second press leaves, whether the preference survives, whether a
// rejected restore falls back to the user's next gesture exactly once.
//
// No DOM library, no ports, no prompts: the stub implements the handful of
// members the bundle touches, and `document.fullscreenElement` is the single
// state every path reads.
//
//   node verify/verify-client.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Load the BUILT artifact, the way the page loads it. */
function loadBundle() {
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let captured
  // The page global the module scope will capture: the environment installs it
  // first, and the loader table rides on that same object.
  const page = globalThis.window
  if (page === undefined) throw new Error('loadBundle needs an environment installed first')
  page.__ModuleLoader__ = {
    load(registration) {
      captured = registration
    }
  }
  // The wrapper is a script, not a module: evaluate it the way a <script> would.
  new Function(bundle)()
  if (captured === undefined) throw new Error('the bundle did not register with __ModuleLoader__')
  if (captured.id !== 'dsh-fullscreen') throw new Error(`the bundle registered as ${String(captured.id)}`)
  let required = 0
  const exported = captured.factory(() => {
    required += 1
    throw new Error('the bundle must not require() anything')
  })
  if (required !== 0) throw new Error('the bundle reached for a module from the shell table')
  if (exported === undefined || exported === null) throw new Error('the bundle exported nothing')
  return exported
}

/** One stub document/window pair, reset between cases. */
function newEnvironment(options = {}) {
  const listeners = { window: new Map(), document: new Map() }
  const calls = { request: 0, exit: 0 }
  const store = new Map(Object.entries(options.storage ?? {}))
  const state = {
    fullscreenElement: null,
    rejectRequest: options.rejectRequest === true,
    rejectExit: false,
    unsupportedApi: options.unsupportedApi === true
  }

  const add = (scope, type, listener) => {
    const set = listeners[scope].get(type) ?? new Set()
    set.add(listener)
    listeners[scope].set(type, set)
  }
  const remove = (scope, type, listener) => {
    listeners[scope].get(type)?.delete(listener)
  }
  const fire = (scope, type, event = {}) => {
    // `defaultPrevented` has to be real state, not a no-op method: the suite
    // asserts on it to tell "this key was honoured" from "this key was eaten".
    const detail = {
      type,
      target: scope === 'window' ? win : doc,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {},
      ...event
    }
    for (const listener of [...(listeners[scope].get(type) ?? [])]) listener(detail)
    return detail
  }
  const count = (scope, type) => listeners[scope].get(type)?.size ?? 0

  const root = {
    tagName: 'HTML',
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    hasAttribute: (name) => root.attributes.has(name),
    requestFullscreen() {
      calls.request += 1
      if (state.unsupportedApi) return Promise.reject(new TypeError('requestFullscreen is not a function'))
      if (state.rejectRequest) return Promise.reject(new TypeError('Permissions check failed'))
      state.fullscreenElement = root
      fire('document', 'fullscreenchange', {})
      return Promise.resolve()
    }
  }

  const doc = {
    documentElement: root,
    body: { tagName: 'BODY' },
    fullscreenEnabled: state.unsupportedApi ? false : true,
    visibilityState: 'visible',
    get fullscreenElement() {
      return state.fullscreenElement
    },
    requestFullscreen: null,
    exitFullscreen() {
      calls.exit += 1
      if (state.rejectExit) return Promise.reject(new Error('not in fullscreen'))
      state.fullscreenElement = null
      fire('document', 'fullscreenchange', {})
      return Promise.resolve()
    },
    addEventListener: (type, listener) => add('document', type, listener),
    removeEventListener: (type, listener) => remove('document', type, listener),
    setAttribute: (name, value) => root.setAttribute(name, value)
  }

  const win = {
    document: doc,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    addEventListener: (type, listener) => add('window', type, listener),
    removeEventListener: (type, listener) => remove('window', type, listener),
    requestAnimationFrame: (callback) => {
      callback(0)
      return 1
    },
    console
  }

  // Install the environment as the page global before anything evaluates the
  // bundle: the module scope captures `window` once, on first evaluation.
  globalThis.window = win

  return { win, doc, root, store, calls, state, fire, count }
}

/** Point the module scope at one environment and rebuild the bundle for it. */
async function applyIn(env, applyArguments = [{}]) {
  const exported = loadBundle()
  if (typeof exported.apply !== 'function') throw new Error('the bundle exports no apply()')
  if (!Array.isArray(exported.inject)) throw new Error('the bundle exports no inject array')
  if (exported.inject.length !== 0) throw new Error('the bundle must declare no required service')
  exported.apply(...applyArguments)
  // The restore path is promise-shaped; let it settle before the assertions run.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return exported
}

/** A key event shaped the way a real KeyboardEvent is. */
const keyEvent = (key, modifiers = {}) => ({
  key,
  code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers
})

const results = []
const check = (name, condition, detail = '') => {
  results.push({ name, ok: condition === true, detail })
}

// 1. F11 enters, F11 leaves, and the memory follows the window, not the key.
{
  const env = newEnvironment()
  await applyIn(env)
  const press = env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check('F11 enters fullscreen', env.state.fullscreenElement !== null, `requestFullscreen calls=${env.calls.request}`)
  check('handled chord is preventDefault-ed', press.defaultPrevented !== false)
  check('preference stored on entry', env.store.get('dsh-fullscreen:on:v1') === '1', JSON.stringify([...env.store]))
  env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check('second F11 leaves fullscreen', env.state.fullscreenElement === null, `exitFullscreen calls=${env.calls.exit}`)
  check('preference cleared on exit', !env.store.has('dsh-fullscreen:on:v1'), JSON.stringify([...env.store]))
}

// 2. Real user activation is what F11 rides on: the request must be the ONLY
//    call, and no chord-shaped key may also start a restore.
{
  const env = newEnvironment({ storage: { 'dsh-fullscreen:on:v1': '1' }, rejectRequest: true })
  await applyIn(env)
  check('rejected restore does not throw or fake state', env.state.fullscreenElement === null)
  check(
    'restore attempted once before the gesture',
    env.calls.request === 1,
    `requestFullscreen calls=${env.calls.request}`
  )
  const listenersBefore = env.count('window', 'pointerdown')
  check('gesture fallback armed after a rejected restore', listenersBefore === 1, `pointerdown listeners=${listenersBefore}`)
  env.state.rejectRequest = false
  env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check(
    'a fullscreen chord never double-toggles through the fallback',
    env.state.fullscreenElement !== null && env.calls.request === 2,
    `fullscreen=${String(env.state.fullscreenElement !== null)} requestFullscreen calls=${env.calls.request}`
  )
  check('fallback disarmed itself once fullscreen arrived', env.count('window', 'pointerdown') === 0)
}

// 3. The restore path when the document really does carry activation.
{
  const env = newEnvironment({ storage: { 'dsh-fullscreen:on:v1': '1' } })
  await applyIn(env)
  check('restore enters fullscreen immediately when allowed', env.state.fullscreenElement !== null)
  check('no fallback is armed after a successful restore', env.count('window', 'pointerdown') === 0)
}

// 4. A pointer gesture is the fallback's other route, and it disarms.
{
  const env = newEnvironment({ storage: { 'dsh-fullscreen:on:v1': '1' }, rejectRequest: true })
  await applyIn(env)
  env.state.rejectRequest = false
  env.fire('window', 'pointerdown', {})
  await Promise.resolve()
  check('the next click completes a rejected restore', env.state.fullscreenElement !== null)
  check('the click fallback disarmed itself', env.count('window', 'pointerdown') === 0)
}

// 5. Nothing is remembered when there is no preference to restore.
{
  const env = newEnvironment()
  await applyIn(env)
  check('no preference means no restore attempt', env.calls.request === 0, `requestFullscreen calls=${env.calls.request}`)
  check('no fallback armed without a preference', env.count('window', 'pointerdown') === 0)
}

// 6. Unrelated keys are not swallowed, and unrelated keys do not toggle.
{
  const env = newEnvironment()
  await applyIn(env)
  for (const key of ['a', 'Escape', 'F12', 'Enter']) {
    const event = env.fire('window', 'keydown', keyEvent(key))
    check(`key ${key} is left alone`, event.defaultPrevented === false && env.calls.request === 0)
  }
}

// 7. macOS convention: Control+Command+F, and only with both modifiers.
{
  const env = newEnvironment()
  await applyIn(env)
  env.fire('window', 'keydown', keyEvent('f', { ctrlKey: true, metaKey: true }))
  await Promise.resolve()
  check('Control+Command+F enters fullscreen', env.state.fullscreenElement !== null)
  const env2 = newEnvironment()
  await applyIn(env2)
  env2.fire('window', 'keydown', keyEvent('f', { metaKey: true }))
  await Promise.resolve()
  check('Command+F alone is left to the page', env2.calls.request === 0)
}

// 8. A user-driven exit is honoured: the reveal path must not fight it.
{
  const env = newEnvironment({ storage: { 'dsh-fullscreen:on:v1': '1' } })
  await applyIn(env)
  check('restored before the exit', env.state.fullscreenElement !== null)
  env.doc.exitFullscreen()
  await Promise.resolve()
  env.fire('window', 'focus', {})
  await Promise.resolve()
  check('the reveal path honours a fresh exit', env.state.fullscreenElement === null, `requestFullscreen calls=${env.calls.request}`)
}

// 9. A second import must not bind a second time (one press = one toggle).
{
  const env = newEnvironment()
  const first = await applyIn(env)
  const second = loadBundle()
  second.apply({})
  await Promise.resolve()
  check('second apply is a no-op', env.count('window', 'keydown') === 1, `keydown listeners=${env.count('window', 'keydown')}`)
  env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check('one press toggles exactly once', env.calls.request === 1, `requestFullscreen calls=${env.calls.request}`)
  check('the diagnostics handle is installed', env.win.__DSH_FULLSCREEN__ !== undefined)
  const snapshot = env.win.__DSH_FULLSCREEN__.state()
  check('diagnostics report the live state', snapshot.fullscreen === true && snapshot.supported === true, JSON.stringify(snapshot))
  check('diagnostics report the entrance', snapshot.entrance === 'key', String(snapshot.entrance))
}

// 10. A document with no Fullscreen API is inert, not broken.
{
  const env = newEnvironment()
  env.doc.fullscreenEnabled = false
  await applyIn(env)
  const event = env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check('unsupported document swallows no key', event.defaultPrevented === false)
  check(
    'unsupported document attempts no request',
    env.calls.request === 0 && env.win.__DSH_FULLSCREEN__.lastError === undefined,
    `requestFullscreen calls=${env.calls.request} lastError=${String(env.win.__DSH_FULLSCREEN__.lastError)}`
  )
  check('unsupported document records the diagnostic', env.win.__DSH_FULLSCREEN__.state().supported === false)
}

// 10b. The feature test must be read live, not remembered. The old shape
//      snapshotted it once, so a document that lost the API after boot kept
//      swallowing F11 and then threw on the missing method.
{
  const env = newEnvironment()
  await applyIn(env)
  check('the API is present before it is taken away', env.win.__DSH_FULLSCREEN__.state().supported === true)
  delete env.root.requestFullscreen
  const event = env.fire('window', 'keydown', keyEvent('F11'))
  await Promise.resolve()
  check('a document that lost the API stops being handled', event.defaultPrevented === false)
  check('and the loss is reported, not thrown', env.win.__DSH_FULLSCREEN__.state().supported === false)
  check(
    'and no request is attempted against the missing method',
    env.calls.request === 0,
    `requestFullscreen calls=${env.calls.request}`
  )
}

// 11. A rejected exit leaves the window where it was and says why.
{
  const env = newEnvironment({ storage: { 'dsh-fullscreen:on:v1': '1' } })
  await applyIn(env)
  env.state.rejectExit = true
  env.fire('window', 'keydown', keyEvent('F11'))
  // The exit answer rides two promise ticks: one to adopt the rejected request,
  // one for its rejection handler. A snapshot taken earlier reads "no answer".
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const snapshot = env.win.__DSH_FULLSCREEN__.state()
  check('a rejected exit does not claim success', snapshot.fullscreen === true)
  check('a rejected exit reports its reason', String(snapshot.lastError).includes('exitFullscreen rejected'), String(snapshot.lastError))
}

const failures = results.filter((result) => !result.ok)
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail === '' ? '' : ` — ${result.detail}`}`)
console.log(`\nverify-client: ${String(results.length - failures.length)}/${String(results.length)} passed`)
if (failures.length > 0) process.exitCode = 1
