#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Build thunderbolt-stdio-bridge as a TINY, self-contained CLI: a single
 * esbuild bundle that runs on the SYSTEM node (no embedded runtime, no npm
 * fetch at runtime). Portable JS — the same artifact runs on every OS/arch,
 * so there is no per-target matrix and no signing.
 *
 * Outputs (into dist/):
 *   - bridge.cjs              the CommonJS bundle (bin/cli.js + ws + MCP SDK),
 *                             carrying `#!/usr/bin/env node` and chmod 0o755 —
 *                             directly runnable on Unix as `./bridge.cjs`. The
 *                             `.cjs` extension makes it unambiguously CommonJS,
 *                             so no sibling package.json `type` override is
 *                             needed and the file is portable on its own.
 *   - thunderbolt-bridge.cmd  a Windows launcher that runs `node bridge.cjs`.
 *
 * The user-facing `thunderbolt-bridge` command name is created at install time
 * (a symlink to bridge.cjs on Unix; the .cmd on Windows) — not here.
 *
 * Usage: node scripts/build-cli.mjs
 */

import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const distDir = join(root, 'dist')
const bundlePath = join(distDir, 'bridge.cjs')
const cmdPath = join(distDir, 'thunderbolt-bridge.cmd')

const run = (cmd, args, opts = {}) => {
  process.stderr.write(`$ ${cmd} ${args.join(' ')}\n`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

const bundle = async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  mkdirSync(distDir, { recursive: true })
  await build({
    entryPoints: [join(root, 'bin', 'cli.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Match the package's real floor (engines >=18.14.1) so the bundle parses on
    // the user's system node, not just node 22. esbuild downgrades only what's
    // needed; newer node still runs it.
    target: 'node18',
    // Keep ws's optional native addons OUT of the bundle so it stays one portable
    // pure-JS artifact for every OS/arch. ws falls back to its JS implementation;
    // bundling a per-platform .node would break the single-artifact guarantee.
    external: ['bufferutil', 'utf-8-validate'],
    outfile: bundlePath,
    // The bundle runs as CommonJS; the entry uses import.meta.url, which esbuild
    // rewrites to a __filename-based shim under platform:node.
    define: {
      // Inline the version so the bundle never needs package.json at runtime.
      __BRIDGE_VERSION__: JSON.stringify(pkg.version),
      // The CJS output has no real import.meta; the only use is deriving the
      // script dir for the package.json version fallback (which never runs in a
      // bundle — version is inlined above). Point it at a banner-defined CJS
      // file URL so the expression stays valid instead of `undefined`.
      'import.meta.url': '__importMetaUrl',
    },
    banner: {
      js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    logLevel: 'info',
  })
  process.stderr.write(`bundled -> ${bundlePath}\n`)
}

const SHEBANG = '#!/usr/bin/env node\n'

/**
 * Make bridge.cjs directly runnable on Unix: ensure the node shebang is present
 * and set the executable bit. `#!/usr/bin/env node` resolves node from PATH
 * (node-on-machine is acceptable; only npx is removed).
 */
const makeBundleExecutable = () => {
  const src = readFileSync(bundlePath, 'utf8')
  // esbuild preserves bin/cli.js's shebang, so the bundle usually already starts
  // with one — only prepend if it's somehow missing (a second line would be a
  // syntax error).
  if (!src.startsWith('#!')) writeFileSync(bundlePath, `${SHEBANG}${src}`)
  chmodSync(bundlePath, 0o755)
  process.stderr.write(`executable -> ${bundlePath}\n`)
}

/**
 * Write the Windows launcher: a .cmd that invokes the system node on the
 * sibling bridge.cjs. `%~dp0` is the directory of the .cmd, so the two ship
 * together. `%*` forwards all args.
 */
const writeWindowsLauncher = () => {
  writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0bridge.cjs" %*\r\n')
  process.stderr.write(`launcher -> ${cmdPath}\n`)
}

/**
 * Prove the bundle is self-contained: run it on the system node with --help.
 * Any unresolved/broken require throws before help prints. On Unix, also smoke
 * the executable bundle directly to prove the shebang launcher works end-to-end.
 */
const verify = () => {
  run(process.execPath, [bundlePath, '--help'], { stdio: 'ignore' })
  process.stderr.write('bundle smoke (--help via node) ok\n')
  if (process.platform !== 'win32') {
    run(bundlePath, ['--help'], { stdio: 'ignore' })
    process.stderr.write('executable smoke (--help) ok\n')
  }
}

await bundle()
makeBundleExecutable()
writeWindowsLauncher()
verify()

process.stderr.write(`\nDone. Run: ${bundlePath} --help\n`)
