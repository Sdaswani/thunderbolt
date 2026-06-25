/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { composeMcpBridgeCommand } from '@/lib/agent-bridge-command'
import { BridgeInstallStep } from '@/components/settings/agents/bridge-install-step'
import { CopyableCommand } from '@/components/settings/agents/copyable-command'

type McpBridgeConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** A numbered step with a title and body. */
const Step = ({ index, title, children }: { index: number; title: string; children: ReactNode }) => (
  <div className="flex gap-3">
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[length:var(--font-size-xs)] font-medium">
      {index}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-[length:var(--font-size-sm)] font-medium">{title}</p>
      {children}
    </div>
  </div>
)

/**
 * Walks the user through exposing a local stdio MCP server through the `zeus
 * bridge`: install the binary, run the bridge wrapping the server's launch
 * command, then add the loopback `http://127.0.0.1:PORT/mcp` URL it prints as a
 * remote server. Unlike the ACP agent catalogue there's no preset entry, so the
 * user supplies the stdio launch command and the run command is composed live.
 */
export const McpBridgeConnectDialog = ({ open, onOpenChange }: McpBridgeConnectDialogProps) => {
  const [command, setCommand] = useState('')
  const bridgeCommand = composeMcpBridgeCommand(command, window.location.origin)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[560px]" data-testid="mcp-bridge-connect-dialog">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Connect a local MCP server via bridge</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Run a local stdio MCP server and expose it to Thunderbolt over a loopback HTTP endpoint.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="flex flex-col gap-5 pt-2">
          <Step index={1} title="Install the bridge (once)">
            <BridgeInstallStep />
          </Step>
          <Step index={2} title="Run the bridge wrapping your server">
            <Label htmlFor="mcp-stdio-command" className="text-[length:var(--font-size-sm)] text-muted-foreground">
              Your server's stdio launch command
            </Label>
            <Input
              id="mcp-stdio-command"
              placeholder="npx @modelcontextprotocol/server-everything stdio"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            {bridgeCommand ? (
              <>
                <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  It prints an{' '}
                  <code className="font-mono text-[length:var(--font-size-xs)]">http://127.0.0.1:PORT/mcp</code> address
                  and stays running.
                </p>
                <CopyableCommand command={bridgeCommand} testId="run" />
              </>
            ) : (
              <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
                Enter the command above to build the runnable bridge command.
              </p>
            )}
          </Step>
          <Step index={3} title="Add the server">
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              Use "Add MCP Server" and paste the printed{' '}
              <code className="font-mono text-[length:var(--font-size-xs)]">http://127.0.0.1:PORT/mcp</code> address as
              the URL (Transport: HTTP).
            </p>
          </Step>
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
