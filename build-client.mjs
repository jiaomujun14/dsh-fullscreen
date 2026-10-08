// Rebuild lib/client.js from src/client.js.
//
// The browser bundle is the source wrapped in the shell's module-loader call —
// the same contract `dsh-boot-animation` uses, verified against
// `@deepseek-ai/dsh-client-modules/lib/client.js`, which registers every
// `/plugins/<id>/client.js` body with
// `window.__ModuleLoader__.load({ id, factory })` and then creates a loader
// entry for it (so the module face the shell resolves is this factory's
// `module.exports` — `inject` plus `apply`).
//
//   window.__ModuleLoader__.load({ id: "dsh-fullscreen", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   <src/client.js verbatim>
//   return module.exports; } });
//
// No bundler: this half imports nothing. `require` stays an unused parameter,
// which is deliberate — the shell's module table is the only source of shared
// modules, and this bundle wants none of them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

const head = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'

const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
if (source.includes('return module.exports; } });')) {
  throw new Error('build-client: src/client.js already carries the loader tail; it is source, not a bundle')
}
if (source.includes('__ModuleLoader__')) {
  throw new Error('build-client: src/client.js mentions __ModuleLoader__; the wrapper owns that name')
}

const bundle = head + source + tail
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), bundle)
console.log(`build-client: lib/client.js written (${String(bundle.length)} chars from ${String(source.length)})`)
