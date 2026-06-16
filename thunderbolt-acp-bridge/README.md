# thunderbolt-acp-bridge

A tiny local helper that bridges a **stdio ACP agent** (Claude Code, Gemini CLI,
Goose, any [Agent Client Protocol](https://agentclientprotocol.com) agent) to a
localhost WebSocket so [Thunderbolt](https://thunderbolt.io) — web or desktop —
can talk to it.

Thunderbolt reaches agents over a WebSocket. Most ACP agents speak **stdio**
(newline-delimited JSON-RPC). `thunderbolt-acp-bridge` spawns your agent and relays its stdio
to a `ws://127.0.0.1:PORT` socket — one JSON object per WebSocket message,
exactly what Thunderbolt expects.

```
Thunderbolt  ⇄  ws://127.0.0.1:PORT  ⇄  thunderbolt-acp-bridge  ⇄  stdio  ⇄  your agent
```

No package manager to install. One dependency (`ws`); everything else is a Node
built-in. Requires **Node.js ≥ 18**.

## Quick start

Run the bridge, putting your agent command after `--`:

```bash
npx thunderbolt-acp-bridge -- <your agent command>
```

A real example (the Claude Code ACP adapter):

```bash
npx thunderbolt-acp-bridge -- npx -y @zed-industries/claude-code-acp
```

The bridge prints a banner with a copyable URL:

```
thunderbolt-acp-bridge ready
  Agent:     npx
  Listening: ws://127.0.0.1:51847

Paste this URL into Thunderbolt → Add Custom Agent:
  ws://127.0.0.1:51847

Ctrl-C to stop.
```

Then, three steps:

1. **Run** the bridge (the command above).
2. **Copy** the printed `ws://127.0.0.1:PORT` URL.
3. **Paste** it into Thunderbolt under **Add Custom Agent**.

On the web app your browser may prompt for **Local Network Access** (Chrome's
prompt) — click **Allow**. The connection goes browser → your own machine;
nothing leaves your computer. Press **Ctrl-C** to stop the bridge; it shuts the
agent down cleanly too.

## Usage

```bash
npx thunderbolt-acp-bridge [options] -- <agent-command> [agent-args...]
```

Everything **after `--`** is your agent command. It's passed **straight to the OS
with no shell** — no quoting bugs, no injection. The `--` separator is required;
without it (or with nothing after it) the bridge tells you so and exits.

### Options

| Flag                 | Default     | Meaning                                                       |
| -------------------- | ----------- | ------------------------------------------------------------- |
| `--port <n>`         | ephemeral   | WebSocket port (0–65535). Omit to let the OS auto-pick a free one. |
| `--host <addr>`      | `127.0.0.1` | Bind address. Loopback only by default. A non-loopback host prints a prominent warning (other machines on your network could then reach the agent). |
| `--allow-origin <o>` | —           | Extra WebSocket `Origin` to accept. **Repeatable.** The Thunderbolt app origins are allowed by default. See [Security](#security). |
| `--allow-any-origin` | off         | Accept **any** `Origin`, disabling the cross-origin guard. Escape hatch for dev/self-host only — prints a startup warning. See [Security](#security). |
| `--verbose`          | off         | Per-frame logging (direction, method, byte size — **redacted**, never content). |
| `--json`             | off         | Emit logs as raw JSON instead of pretty one-liners.           |
| `--help` / `-h`      |             | Show help and exit.                                           |
| `--version` / `-v`   |             | Print the version and exit.                                   |

`--port`, `--host`, and `--allow-origin` accept either form: `--port 51847` or
`--port=51847`.

## How it works

`thunderbolt-acp-bridge` is a pure byte relay — it links no ACP SDK and never interprets the
protocol. It spawns your agent once and reuses that single child process across
WebSocket reconnects (so session state survives). Agent stdout is split into
lines and each non-empty JSON object is sent as exactly one WebSocket frame;
each inbound WebSocket message is written to the agent's stdin with a trailing
newline. Non-JSON stdout lines are dropped (Thunderbolt does an unguarded
`JSON.parse` per message). On Ctrl-C / `SIGTERM` it closes the socket and
`SIGTERM`s the agent, escalating to `SIGKILL` after 2 s so the agent is never
orphaned; if the agent exits on its own, the bridge tears down with it.

## Security

The WebSocket server binds **`127.0.0.1` only** by default, so it's reachable
solely from your own machine.

That's not enough on its own: browser WebSocket connections are **not**
same-origin-protected, and this server fronts a privileged local agent that can
read/write files and run terminal commands. Without a guard, any web page open
in a browser on your machine could connect to `ws://127.0.0.1:PORT` and drive
your agent. So the bridge accepts a connection only when its `Origin` header is a
known Thunderbolt app origin:

- `https://app.thunderbolt.io` — production web app
- `tauri://localhost` and `http://tauri.localhost` — Tauri desktop/mobile webview
- `http://localhost:1420` — Vite dev server (web + Tauri dev)
- a **missing/empty** `Origin` — native and Tauri webviews routinely send none

A disallowed `Origin` is rejected during the WebSocket handshake (HTTP `403`, so
a hostile page never even briefly connects); a defense-in-depth check also closes
any such socket with code `1008`.

- **Add an origin:** `--allow-origin <origin>` (repeatable) for dev or self-host.
- **Turn the check off:** `--allow-any-origin`. This lets **any** browser page on
  the machine drive your agent — only use it on a trusted dev/self-host machine.
  It prints a loud startup warning.

## Logging & privacy

`thunderbolt-acp-bridge` never logs ACP message content. Log records are built from an
**allowlist of scalars** — there is no code path that copies a frame body into a
log line. Logged fields are limited to: direction, message kind, a fixed set of
known method names (anything else collapses to `other`), a scalar JSON-RPC id
(long string ids are truncated), byte size, status, integer error codes, and
lifecycle events. The `Origin` header is sanitized to scheme + host before
logging.

Prompt text, tool output, file paths, tokens, and your agent's argv are **never**
logged — even with `--verbose`. Dropped or malformed stdout lines are logged by
**byte size only**. The agent's own stderr passes through to your terminal
untouched.

## Troubleshooting

The bridge prints an actionable message to stderr and exits with a specific code:

| Exit | When | Fix |
| ---- | ---- | --- |
| `0`  | Clean shutdown (agent exited normally, or Ctrl-C with the agent gone). | Nothing — normal exit. |
| `64` | **Bad invocation.** Missing `--` separator, no agent command, an unknown option, or an invalid `--port`. | Re-check the command. The agent command goes after `--`, e.g. `npx thunderbolt-acp-bridge -- npx -y @zed-industries/claude-code-acp`. |
| `69` | **Agent or server problem.** `command not found` (agent not on PATH), `permission denied` (agent not executable), the agent **exited before speaking ACP**, port already in use, or the agent exited non-zero while running. | For "command not found", install the agent / check your PATH. For "exited before speaking ACP", run the agent command directly to see its error (its stderr also prints above the message). For "port already in use", omit `--port` to auto-pick or choose another. |
| `130`| **Ctrl-C / `SIGTERM`.** You stopped the bridge. | Nothing — expected interrupt. |

## Development

```bash
bun install
bun test
```

## License

MPL-2.0
