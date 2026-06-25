/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Check, Download, Loader2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { composeInstallCommand } from '@/lib/agent-bridge-command'
import { installBridge } from '@/lib/bridge-install'
import { getPlatform } from '@/lib/platform'
import { CopyableCommand } from './copyable-command'

/**
 * Auto-install shells out to a POSIX login shell to run `install.sh` (which needs
 * node/npm/curl), so it's only offered on macOS/Linux desktops. Windows desktop
 * and web fall back to the manual `curl | bash` command.
 */
const canAutoInstall = (): boolean => {
  const os = getPlatform()
  return os === 'macos' || os === 'linux'
}

type InstallState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'done' }
  | { phase: 'error'; message: string }

// Icon + label per install phase. `error` reuses the idle affordance: the button
// re-enables so the click retries.
const phaseIcon: Record<InstallState['phase'], LucideIcon> = {
  idle: Download,
  installing: Loader2,
  done: Check,
  error: Download,
}
const phaseLabel: Record<InstallState['phase'], string> = {
  idle: 'Install automatically',
  installing: 'Installing…',
  done: 'Installed',
  error: 'Install automatically',
}

type BridgeInstallStepProps = {
  /** Test seams — default to real platform detection and the Tauri installer. */
  autoInstallable?: boolean
  installFn?: () => Promise<string>
}

/**
 * The "install the bridge" step shared by the ACP and MCP connect dialogs. Where
 * auto-install isn't available (web, Windows desktop) it shows the manual
 * `curl | bash` command. On macOS/Linux desktop it adds an "Install automatically"
 * button that runs the installer through a Rust command, falling back to the manual
 * command — auto on success, surfaced inline on error.
 */
export const BridgeInstallStep = ({
  autoInstallable = canAutoInstall(),
  installFn = installBridge,
}: BridgeInstallStepProps = {}) => {
  const [state, setState] = useState<InstallState>({ phase: 'idle' })

  if (!autoInstallable) {
    return <CopyableCommand command={composeInstallCommand()} testId="install" />
  }

  const runInstall = async () => {
    setState({ phase: 'installing' })
    try {
      await installFn()
      setState({ phase: 'done' })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const failed = state.phase === 'error'
  const Icon = phaseIcon[state.phase]

  return (
    <div className="flex flex-col gap-3">
      <Button
        onClick={runInstall}
        disabled={state.phase === 'installing' || state.phase === 'done'}
        variant="outline"
        className="self-start"
        data-testid="bridge-install-auto"
      >
        <Icon
          className={
            state.phase === 'installing' ? 'animate-spin' : state.phase === 'done' ? 'text-success' : undefined
          }
        />
        {phaseLabel[state.phase]}
      </Button>
      {failed && (
        <p className="text-[length:var(--font-size-sm)] text-destructive" data-testid="bridge-install-error">
          {state.message}
        </p>
      )}
      <details open={failed}>
        <summary className="cursor-pointer text-[length:var(--font-size-sm)] text-muted-foreground">
          Install manually
        </summary>
        <div className="pt-2">
          <CopyableCommand command={composeInstallCommand()} testId="install" />
        </div>
      </details>
    </div>
  )
}
