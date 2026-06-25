/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { composeInstallCommand } from '@/lib/agent-bridge-command'
import { installBridge } from '@/lib/bridge-install'
import { isDesktop } from '@/lib/platform'
import { CopyableCommand } from './copyable-command'

type InstallState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'done' }
  | { phase: 'error'; message: string }

type BridgeInstallStepProps = {
  /** Test seams — default to real desktop detection and the Tauri installer. */
  desktop?: boolean
  installFn?: () => Promise<string>
}

/**
 * The "install the bridge" step shared by the ACP and MCP connect dialogs. On
 * web there's no terminal we can drive, so it shows the manual `curl | bash`
 * command. On desktop (Tauri) it adds an "Install automatically" button that runs
 * the installer through a Rust command, falling back to the manual command — auto
 * on success, surfaced inline on error.
 */
export const BridgeInstallStep = ({
  desktop = isDesktop(),
  installFn = installBridge,
}: BridgeInstallStepProps = {}) => {
  const [state, setState] = useState<InstallState>({ phase: 'idle' })

  if (!desktop) {
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

  return (
    <div className="flex flex-col gap-3">
      <Button
        onClick={runInstall}
        disabled={state.phase === 'installing' || state.phase === 'done'}
        variant="outline"
        className="self-start"
        data-testid="bridge-install-auto"
      >
        {state.phase === 'installing' ? (
          <Loader2 className="animate-spin" />
        ) : state.phase === 'done' ? (
          <Check className="text-success" />
        ) : (
          <Download />
        )}
        {state.phase === 'installing' ? 'Installing…' : state.phase === 'done' ? 'Installed' : 'Install automatically'}
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
