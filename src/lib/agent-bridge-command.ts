/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shell-command composers for the stdio-bridge connect flow.
 *
 * A catalogue agent is a local CLI (npx / uvx / binary). To reach it from the
 * app the user runs `thunderbolt-stdio-bridge`, which spawns the agent's CLI and
 * exposes it over a loopback WebSocket (`ws://127.0.0.1:PORT`). These helpers
 * build the three copyable commands the connect dialog walks the user through:
 *
 *   1. install the bridge (`composeInstallCommand`)
 *   2. run the bridge wrapping the agent (`composeBridgeCommand`)
 *   3. (the launch fragment alone, `composeLaunchCommand`, for display/tests)
 *
 * Binary-distributed agents have no portable one-line launch, so
 * `composeBridgeCommand` returns `null` for them and the UI points the user at
 * the agent's own site/repo instead.
 */

import { isLoopbackUrl } from '@/acp/transports/is-loopback'
import type { RegistryEntry } from '@/types/registry'

/** The command name the app's `install.sh` installs onto PATH. */
const bridgeBin = 'thunderbolt-stdio-bridge'

/** Canonical one-line installer (curl | bash) — matches
 *  `thunderbolt-stdio-bridge/install.sh`'s documented invocation. The bridge
 *  drops onto the npm global bin as a node-shebang script. */
const installCommand =
  'curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/thunderbolt-stdio-bridge/install.sh | bash'

/**
 * The shell fragment that launches the agent's own CLI, e.g.
 * `npx @google/gemini-cli@0.46.0 --acp` or `uvx fast-agent ...`. Returns `null`
 * for binary distributions (no portable runner) — the UI falls back to the
 * agent's site/repo. Prefers npx over uvx, matching `primaryDistributionKind`.
 */
export const composeLaunchCommand = (entry: RegistryEntry): string | null => {
  const npx = entry.distribution.npx
  if (npx) {
    return ['npx', npx.package, ...(npx.args ?? [])].join(' ')
  }
  const uvx = entry.distribution.uvx
  if (uvx) {
    return ['uvx', uvx.package, ...(uvx.args ?? [])].join(' ')
  }
  return null
}

/** The curl | bash command that installs the bridge onto the user's PATH. */
export const composeInstallCommand = (): string => installCommand

/**
 * Whether a copied bridge command needs an explicit `--allow-origin`: only for a
 * valid, non-loopback http(s) app origin (production web). Opaque origins (the
 * literal `'null'`, `file:`, sandboxed frames) and loopback origins need nothing
 * — the bridge's default allowlist already accepts loopback and absent Origins.
 */
const needsAllowOrigin = (origin: string | undefined): origin is string => {
  if (!origin) {
    return false
  }
  try {
    const { protocol } = new URL(origin)
    return (protocol === 'http:' || protocol === 'https:') && !isLoopbackUrl(origin)
  } catch {
    return false
  }
}

/**
 * The full bridge command for an agent:
 * `thunderbolt-stdio-bridge --mode acp -- <launch>`. The bridge is the bare
 * binary `install.sh` drops on PATH — invoke it directly (no `npx`, which would
 * hit the registry since the bridge is never published to npm). Returns `null`
 * when the agent only ships a binary distribution (no composable launch
 * fragment), so the dialog can render its binary fallback instead.
 *
 * When `origin` is a non-loopback app origin (production web), the bridge's
 * default loopback-only Origin allowlist would reject the browser's WS upgrade,
 * so we add `--allow-origin '<origin>'`. A loopback origin (or none) needs
 * nothing extra — the default allowlist already accepts loopback.
 *
 * The catalogue is ACP-only, so `--mode acp` is always correct here.
 */
export const composeBridgeCommand = (entry: RegistryEntry, origin?: string): string | null => {
  const launch = composeLaunchCommand(entry)
  if (!launch) {
    return null
  }
  const allowOrigin = needsAllowOrigin(origin) ? `--allow-origin '${origin}' ` : ''
  return `${bridgeBin} --mode acp ${allowOrigin}-- ${launch}`
}
