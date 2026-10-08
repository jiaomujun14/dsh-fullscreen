window.__ModuleLoader__.load({ id: "dsh-fullscreen", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-fullscreen — browser half.
//
// One job: let the user put the DSH window into real operating-system fullscreen
// from the page, and keep it there. Nothing here talks to the Host, because the
// Host cannot help: `@deepseek-ai/dsh-plugin-desktop`'s renderer action
// whitelist is `terminal | developer | diagnostics | check-for-updates |
// restart | restart-recovery | reload`, and its preload exposes no window
// control beyond `dshDesktopActions.invoke`. The only fullscreen channel the
// page owns is the DOM Fullscreen API, which Electron turns into
// `BrowserWindow.setFullScreen(true)`.
//
// Why the API is available at all: on Windows the shell calls
// `window.removeMenu()`, so the default `F11 = togglefullscreen` accelerator
// does not exist in this deployment, and the window options
// (`electron-runtime-*.js` → `baseWindowOptions()`) never set
// `fullscreenable: false`. So the window CAN be fullscreen; it simply has no
// switch. This bundle is that switch.
//
// Bound every route, as this toolkit's other packages do: no key is ever
// swallowed when the API is unavailable, a rejected request leaves the window
// exactly where it was, and a request that fails leaves a reason in
// `window.__DSH_FULLSCREEN__` instead of a silent no-op.
//
// Artifact contract: this file is a script body, not a module. The build wraps
// it in the shell's loader call, which supplies `module`, `exports` and
// `require`, and evaluates it inside a function — where `export` statements are
// a syntax error and a top-level `foo = …` assignment would quietly write to the
// page global. So this half declares everything with `const`/`function`, keeps
// its state in closure scope, and hands the plugin face out through
// `module.exports` at the bottom. Never write `export` in this file.

/** Where the preference lives. Read on every restore, written on every change. */
const STORAGE_KEY = 'dsh-fullscreen:on:v1'

/** Marks the document once this bundle has attached, so a double import cannot double-bind. */
const ATTACHED_ATTRIBUTE = 'data-dsh-fullscreen'

/** A user-initiated exit must not be undone by the reveal path within this window. */
const EXIT_QUIET_MS = 1500

/** Diagnostics handle. Kept on `window` so nothing depends on a service being present. */
const DIAGNOSTICS = '__DSH_FULLSCREEN__'

/**
 * Standalone export name. The Host's compatibility shell hosts the renderer in a
 * `WebContentsView`, so `window` here is the renderer's own global.
 */
const GLOBAL = typeof window === 'undefined' ? undefined : window

/**
 * Feature test.
 *
 * Read live on every use, never snapshotted into a constant: the first verdict
 * belongs to the document that happened to exist when the artifact was
 * evaluated, and a stale verdict is worse than no verdict — an "unavailable"
 * captured once keeps the chord swallowed forever, and an "available" captured
 * once makes every later call throw on a document that has no such method.
 * @returns whether the DOM Fullscreen API is usable on the current document.
 */
function isSupported() {
  if (GLOBAL === undefined) return false
  const doc = GLOBAL.document
  if (doc === undefined || doc === null) return false
  if (typeof doc.documentElement?.requestFullscreen !== 'function') return false
  return doc.fullscreenEnabled !== false
}

/** Why the API is not usable, for the diagnostics record. */
const UNSUPPORTED_REASON = 'the DOM Fullscreen API is unavailable here'

/**
 * Whether a key event asks for the platform's fullscreen toggle.
 *
 * F11 is the Windows/Linux convention. macOS uses Control+Command+F, and the
 * macOS shell that GitHub discussion #7717 complains about does NOT install it
 * (`platformMenus()` on darwin has only fileMenu/editMenu/windowMenu, and the
 * `Enter Full Screen` the reporter saw is injected by macOS itself with the
 * system's own key, not ⌃⌘F). Since the desk the window runs on is not knowable
 * from the page, both are accepted and each is judged only by its own shape.
 * @param event - the keydown event under test.
 * @returns whether the event is a fullscreen toggle.
 */
function isFullscreenChord(event) {
  if (event === undefined || event === null) return false
  const key = typeof event.key === 'string' ? event.key : ''
  const code = typeof event.code === 'string' ? event.code : ''
  if (key === 'F11' || code === 'F11') return true
  if ((key === 'f' || key === 'F') && event.ctrlKey === true && event.metaKey === true) return true
  return false
}

/**
 * Build the diagnostics surface and install it on the page's global.
 *
 * `state()` is the one call a support session needs: it answers whether the
 * bundle attached, whether the window is currently fullscreen, whether the
 * restore path has already run, and what the last request answered.
 * @returns the diagnostics record, so callers can keep writing to it.
 */
function installDiagnostics() {
  const record = {
    version: '0.1.0',
    supported: isSupported(),
    attached: false,
    attachedAt: undefined,
    entrance: undefined,
    lastAction: undefined,
    lastError: undefined,
    lastChangeAt: undefined,
    restoreRun: false,
    state() {
      return {
        // Live, like the guard itself: a document that gains or loses the API
        // after attach must not keep reporting the verdict from its first read.
        supported: isSupported(),
        attached: record.attached,
        entrance: record.entrance,
        preference: readPreference(),
        fullscreen: GLOBAL?.document?.fullscreenElement != null,
        fullscreenElement: describeElement(GLOBAL?.document?.fullscreenElement),
        restoreRun: record.restoreRun,
        lastAction: record.lastAction,
        lastError: record.lastError,
        lastChangeAt: record.lastChangeAt
      }
    },
    /** Turn "come up fullscreen next boot" on or off without touching the window. */
    setPreference(on) {
      writePreference(on === true)
      return readPreference()
    },
    /** Enter or leave fullscreen now, the same way the F11 handler does. */
    toggle() {
      return toggleFullscreen('diagnostics')
    }
  }
  try {
    GLOBAL[DIAGNOSTICS] = record
  } catch (cause) {
    // A frozen global is not a reason to stop working; the console lines remain.
  }
  return record
}

/**
 * The three entry paths this bundle can arrive through, kept so the diagnostics
 * can name the one that actually happened.
 *
 * 1. named `apply` export — the shape a Cordis loader resolves from a namespace export.
 * 2. default export object — the shape `dsh-boot-animation` relies on.
 * 3. class-style default export — the loader instantiating and calling `apply`.
 *
 * All three funnel into one `attach()`, which is idempotent, because a bundle
 * that binds its listeners twice would toggle twice per press.
 */
let diagnostics
let binding
let attached = false

/** Describe a node for the diagnostics without pulling a DOM serializer in. */
function describeElement(node) {
  if (node === undefined || node === null) return undefined
  const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : 'node'
  const id = typeof node.id === 'string' && node.id !== '' ? `#${node.id}` : ''
  return `${tag}${id}`
}

/** Read the stored preference. Anything unreadable counts as "off". */
function readPreference() {
  try {
    return GLOBAL?.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch (cause) {
    return false
  }
}

/** Write the stored preference, tolerating a storage that refuses writes. */
function writePreference(on) {
  try {
    if (on) GLOBAL?.localStorage?.setItem(STORAGE_KEY, '1')
    else GLOBAL?.localStorage?.removeItem(STORAGE_KEY)
  } catch (cause) {
    // Private-mode storage or a quota error: the window still toggles, only the memory is lost.
  }
}

/** One line to the page console, the same place every other DSH client plugin reports. */
function report(message) {
  try {
    console.info(`[dsh-fullscreen] ${message}`)
  } catch (cause) {
    // Never let logging break the feature.
  }
}

/**
 * Enter or leave fullscreen, and record what the browser answered.
 *
 * A rejected request is the interesting case and must stay quiet: on this path
 * a rejection means the document had no transient user activation (Chromium
 * requires it for `requestFullscreen`), so the caller's fallback — the one-shot
 * gesture listener in `armRestore` — is what makes the restore happen.
 * @param entrance - which path asked, for the diagnostics.
 * @param options - `quiet` suppresses the console line for fallback attempts.
 * @returns a promise resolving to `true` when the request was accepted.
 */
function toggleFullscreen(entrance, options = {}) {
  const doc = GLOBAL?.document
  if (diagnostics !== undefined) diagnostics.entrance = entrance
  if (!isSupported() || doc === undefined || doc === null) {
    if (diagnostics !== undefined) diagnostics.lastError = UNSUPPORTED_REASON
    return Promise.resolve(false)
  }
  const quiet = options.quiet === true
  const active = doc.fullscreenElement
  if (active !== null && active !== undefined) {
    if (!quiet) report('leaving fullscreen (asked by ' + entrance + ')')
    const leaving = Promise.resolve(doc.exitFullscreen()).then(
      () => {
        if (diagnostics !== undefined) diagnostics.lastAction = 'exit'
        return true
      },
      (cause) => {
        if (diagnostics !== undefined) diagnostics.lastError = `exitFullscreen rejected: ${String(cause)}`
        return false
      }
    )
    return leaving
  }
  if (!quiet) report('entering fullscreen (asked by ' + entrance + ')')
  const target = doc.documentElement ?? doc.body
  const entering = Promise.resolve(target.requestFullscreen()).then(
    () => {
      if (diagnostics !== undefined) {
        diagnostics.lastAction = 'enter'
        diagnostics.lastError = undefined
      }
      return true
    },
    (cause) => {
      if (diagnostics !== undefined) diagnostics.lastError = `requestFullscreen rejected: ${String(cause)}`
      if (!quiet) report(`requestFullscreen rejected: ${String(cause)}`)
      return false
    }
  )
  return entering
}

/** Whether the window is in fullscreen right now. */
function inFullscreen() {
  return GLOBAL?.document?.fullscreenElement != null
}

/**
 * Wire the three behaviours of this bundle exactly once.
 *
 * The listeners are installed outside any Cordis effect scope on purpose: the
 * page is their owner, every path below is bounded, and an effect-scoped
 * listener would be torn down together with a fiber whose only job in this
 * deployment is to exist — taking the feature with it.
 * @returns whether this call did the binding.
 */
function attach(entrance) {
  const doc = GLOBAL?.document
  if (doc === undefined || doc === null) return false
  // The guard is threefold on purpose: a loader that resolves both the namespace
  // and the default export of this module calls `apply` twice, and a bundle
  // whose listeners bind twice toggles twice per press.
  if (attached || doc.documentElement?.hasAttribute?.(ATTACHED_ATTRIBUTE) === true) {
    attached = true
    return false
  }
  attached = true

  diagnostics = installDiagnostics()
  diagnostics.attached = true
  diagnostics.attachedAt = new Date().toISOString()
  diagnostics.entrance = entrance

  let exitedAt = 0

  // 1. The key chord. Capture phase so a focused input cannot stop it, and
  //    `preventDefault` only on the chord we can actually honour: a document
  //    without the Fullscreen API must not swallow F11, or the page loses the
  //    key to a feature that is not there.
  binding = (event) => {
    if (!isSupported()) return
    if (!isFullscreenChord(event)) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    disarmGesture()
    void toggleFullscreen('key')
  }
  GLOBAL.addEventListener('keydown', binding, true)

  // 2. Memory. Two sources of truth exist — the callback path and the event —
  //    so the event is the one that writes, because it also fires when the user
  //    leaves fullscreen with Esc or the system's own key. It is also the one
  //    place that knows the window really did become fullscreen, which is where
  //    a pending gesture fallback stops being needed.
  const onFullscreenChange = () => {
    const entered = inFullscreen()
    exitedAt = entered ? 0 : Date.now()
    diagnostics.lastChangeAt = new Date().toISOString()
    if (entered) disarmGesture()
    writePreference(entered)
    report(entered ? 'fullscreen on (remembered)' : 'fullscreen off (forgotten)')
  }
  doc.addEventListener('fullscreenchange', onFullscreenChange)

  // 3. Restore. `show()` on the Host side already restores a window that was in
  //    fullscreen when it was hidden to the tray, so this path covers the two
  //    cases the shell cannot: a page reload and a renderer recovery, where the
  //    window stayed maximized but the document forgot.
  const onReveal = () => {
    if (Date.now() - exitedAt < EXIT_QUIET_MS) return
    if (inFullscreen()) return
    if (!readPreference()) return
    void restoreAfterGesture()
  }
  GLOBAL.addEventListener('focus', onReveal)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') onReveal()
  })

  markAttached(doc)
  if (readPreference()) void restoreNow()

  report(
    isSupported()
      ? 'attached: F11 (or Control+Command+F) toggles window fullscreen'
      : 'attached but inert: this document has no DOM Fullscreen API'
  )
  return true
}

/** Mark the document so a second import of the bundle can tell it already ran. */
function markAttached(doc) {
  try {
    doc.documentElement?.setAttribute?.(ATTACHED_ATTRIBUTE, '1')
  } catch (cause) {
    // A read-only root element would only cost us the marker.
  }
}

/**
 * Try the restore immediately.
 *
 * Chromium only honours `requestFullscreen` with transient user activation, and
 * whether a freshly loaded renderer has it depends on how the shell opened the
 * window — which is not knowable from the page. So this attempt is made quietly
 * and its rejection is expected on the reload path.
 */
function restoreNow() {
  if (diagnostics !== undefined) diagnostics.restoreRun = true
  return toggleFullscreen('restore', { quiet: true }).then((accepted) => {
    if (accepted) {
      report('restored fullscreen from the remembered state')
      return true
    }
    armGestureRestore()
    return false
  })
}

/**
 * Wait for one first paint, then read the preference again.
 *
 * The wait is what keeps this honest: the shell reveals the window after the
 * document loads, and a `requestFullscreen` issued before the first frame is
 * exactly the kind of thing that silently does nothing.
 */
function restoreAfterGesture() {
  if (diagnostics !== undefined) diagnostics.restoreRun = true
  return afterFirstFrame().then(() => restoreNow())
}

/** Resolve after one animation frame, or immediately where there is no frame clock. */
function afterFirstFrame() {
  return new Promise((resolve) => {
    const raf = GLOBAL?.requestAnimationFrame
    if (typeof raf !== 'function') {
      resolve()
      return
    }
    raf(() => resolve())
  })
}

/**
 * Make the user's next interaction the activation this document may be missing.
 *
 * The listener is one-shot, capture-phase and never calls `preventDefault`, so
 * the gesture it borrows still does whatever the user meant it to do. It is
 * dropped the moment the window really is fullscreen, when the preference goes
 * away, and when the document stops being visible — a fallback that keeps
 * listening is a fallback that can still surprise someone an hour later.
 */
let gestureArmed = false

/**
 * The live disarm step, hoisted so the paths that do not go through the gesture
 * can retire it too: the window becoming fullscreen by any route (the chord, the
 * system key, the Host restoring it) means the fallback has nothing left to do,
 * and a fallback that keeps listening is a fallback that can still surprise
 * someone an hour later.
 */
let gestureDisarm = null

/** Retire the pending gesture fallback, if one is armed. Safe to call always. */
function disarmGesture() {
  const dispose = gestureDisarm
  gestureDisarm = null
  gestureArmed = false
  if (typeof dispose === 'function') dispose()
}

function armGestureRestore() {
  if (gestureArmed) return
  const doc = GLOBAL?.document
  if (doc === undefined || doc === null) return
  if (typeof GLOBAL.addEventListener !== 'function') return
  report('fullscreen could not be restored without a click; the next click or key press will do it')

  const onGesture = (event) => {
    // A fullscreen chord is not a generic gesture: it belongs to the key
    // binding above, and letting both handle it would toggle twice per press.
    if (event !== undefined && event !== null && event.type === 'keydown' && isFullscreenChord(event)) return
    if (inFullscreen() || !readPreference()) {
      disarmGesture()
      return
    }
    void toggleFullscreen('restore-gesture', { quiet: true }).then((accepted) => {
      if (accepted) disarmGesture()
    })
  }
  const onVisibility = () => {
    // Leaving the document re-arms nothing; disarming here keeps the listener
    // count honest across a long-lived session.
    if (doc.visibilityState !== 'visible') disarmGesture()
  }
  gestureDisarm = () => {
    GLOBAL?.removeEventListener('pointerdown', onGesture, true)
    GLOBAL?.removeEventListener('keydown', onGesture, true)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
  GLOBAL.addEventListener('pointerdown', onGesture, true)
  GLOBAL.addEventListener('keydown', onGesture, true)
  doc.addEventListener('visibilitychange', onVisibility)
  gestureArmed = true
}

/**
 * The Cordis entry point. Empty `inject` is deliberate: this half needs no
 * service, so it can never be left PENDING by a profile that lacks one — the
 * same reason `dsh-boot-animation`'s client half declares none.
 */
const inject = []

/**
 * Apply the plugin.
 *
 * `ctx` is accepted and deliberately unused beyond an optional log line: this
 * bundle renders no seat and owns no service, so the only thing binding it to
 * the Host generation is that the Host loaded the row at all.
 * @param ctx - the client plugin context, when the loader passes one.
 * @returns nothing.
 */
function apply(ctx) {
  const logger = ctx?.logger
  try {
    logger?.debug?.('[dsh-fullscreen] browser half applied')
  } catch (cause) {
    // A logger that throws is not a reason to skip the feature.
  }
  attach('apply')
}

// The module face the shell's loader resolves. `default` is carried too, because
// the loader may reach for either the namespace or its default export; both
// spellings point at the same two functions, and `apply` is idempotent, so a
// loader that resolves both cannot double-bind.
//
// Nothing attaches at import time: the shell imports the bundle and only then
// creates the loader entry that calls `apply`, so binding here would bind before
// there is a page generation to bind to.
module.exports = { inject, apply, default: { inject, apply } }


return module.exports; } });
