# thunderbolt-stdio-bridge

A tiny local helper that bridges a **local stdio agent or MCP server** to
[Thunderbolt](https://thunderbolt.io) — web or desktop — over localhost.

It has two protocol faces, picked with a required `--mode` flag:

- **`--mode acp`** — bridges a **stdio ACP agent** (Claude Code, Gemini CLI, Goose,
  any [Agent Client Protocol](https://agentclientprotocol.com) agent) to a localhost
  WebSocket. Thunderbolt reaches ACP agents over a WebSocket; most speak **stdio**
  (newline-delimited JSON-RPC), so the bridge relays one JSON object per WebSocket
  message — exactly what Thunderbolt expects.
- **`--mode mcp`** — serves a **stdio MCP server** over **Streamable HTTP** at
  `http://127.0.0.1:PORT/mcp`, the transport Thunderbolt's _Add MCP Server_ flow
  speaks. Optionally exposes it over a public [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  tunnel (`--tunnel`) with a mandatory bearer secret.

```
Thunderbolt  ⇄  ws://127.0.0.1:PORT          ⇄  thunderbolt-stdio-bridge --mode acp  ⇄  stdio  ⇄  your ACP agent
Thunderbolt  ⇄  http://127.0.0.1:PORT/mcp     ⇄  thunderbolt-stdio-bridge --mode mcp  ⇄  stdio  ⇄  your MCP server
```

No package manager to install. Two dependencies (`ws` and the official
`@modelcontextprotocol/sdk`); everything else is a Node built-in. Requires
**Node.js ≥ 18**.

## Quick start

Pick a mode and put the command to run after `--`:

```bash
# Bridge an ACP agent over a WebSocket:
npx thunderbolt-stdio-bridge --mode acp -- npx -y @zed-industries/claude-code-acp

# Bridge an MCP server over Streamable HTTP:
npx thunderbolt-stdio-bridge --mode mcp -- npx -y @modelcontextprotocol/server-everything
```

`--mode` is **required** — there is no default. The stdio child is either an ACP
agent or an MCP server, and the bridge won't guess.

The bridge prints a banner with a copyable URL. In ACP mode:

```
thunderbolt-stdio-bridge ready
  Agent:     npx
  Listening: ws://127.0.0.1:51847

Paste this URL into Thunderbolt → Add Custom Agent:
  ws://127.0.0.1:51847

Ctrl-C to stop.
```

In MCP mode:

```
thunderbolt-stdio-bridge ready (MCP)
  Server:    npx
  Listening: http://127.0.0.1:51847/mcp

Paste this URL into Thunderbolt → Add MCP Server:
  http://127.0.0.1:51847/mcp

Ctrl-C to stop.
```

Then, three steps:

1. **Run** the bridge (a command above).
2. **Copy** the printed URL.
3. **Paste** it into Thunderbolt — under **Add Custom Agent** (acp) or **Add MCP
   Server** (mcp).

On the web app your browser may prompt for **Local Network Access** (Chrome's
prompt) — click **Allow**. The connection goes browser → your own machine;
nothing leaves your computer. Press **Ctrl-C** to stop the bridge; it shuts the
agent down cleanly too.

## Usage

```bash
npx thunderbolt-stdio-bridge --mode <acp|mcp> [options] -- <command> [args...]
```

Everything **after `--`** is your command. It's passed **straight to the OS with
no shell** — no quoting bugs, no injection. The `--` separator is required;
without it (or with nothing after it) the bridge tells you so and exits.

### Options

| Flag                 | Default      | Meaning                                                                                                                                                                 |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode <acp\|mcp>`  | **required** | Protocol face: `acp` = WebSocket relay for an ACP agent, `mcp` = MCP Streamable HTTP server at `/mcp`.                                                                  |
| `--tunnel`           | off          | **(mcp only)** Expose the MCP face over a public cloudflared tunnel with a mandatory auto-generated bearer. Rejected with `--mode acp`. See [Tunnel](#tunnel-mcp-only). |
| `--port <n>`         | ephemeral    | WebSocket/HTTP port (0–65535). Omit to let the OS auto-pick a free one.                                                                                                 |
| `--host <addr>`      | `127.0.0.1`  | Bind address. Loopback only by default. A non-loopback host prints a prominent warning (other machines on your network could then reach the agent).                     |
| `--allow-origin <o>` | —            | Extra `Origin` to accept (applies to both faces). **Repeatable.** The Thunderbolt app origins are allowed by default. See [Security](#security).                        |
| `--allow-any-origin` | off          | Accept **any** `Origin`, disabling the cross-origin guard. Escape hatch for dev/self-host only — prints a startup warning. See [Security](#security).                   |
| `--verbose`          | off          | Per-frame logging (direction, method, byte size — **redacted**, never content).                                                                                         |
| `--json`             | off          | Emit logs as raw JSON instead of pretty one-liners.                                                                                                                     |
| `--help` / `-h`      |              | Show help and exit.                                                                                                                                                     |
| `--version` / `-v`   |              | Print the version and exit.                                                                                                                                             |

`--port`, `--host`, and `--allow-origin` accept either form: `--port 51847` or
`--port=51847`.

## How it works

Both faces wrap a **single persistent stdio child**, spawned once and reused
across reconnects so session state survives. The bridge spawns your command with
`['pipe','pipe','inherit']`, so the agent's own **stderr passes through to your
terminal untouched** (the bridge never parses or logs it). On Ctrl-C / `SIGTERM`
it tears down the face and `SIGTERM`s the child, escalating to `SIGKILL` after a
grace window so the child is never orphaned; if the child exits on its own, the
bridge tears down with it.

- **ACP mode** is a pure byte relay — it links no ACP SDK and never interprets the
  protocol. Agent stdout is split into lines and each non-empty JSON object is sent
  as exactly one WebSocket frame; each inbound WebSocket message is written to the
  agent's stdin with a trailing newline. Non-JSON stdout lines are dropped
  (Thunderbolt does an unguarded `JSON.parse` per message). A new connection
  supersedes the previous one (newest-wins), and while no client is connected the
  relay is paused so an in-flight response is held by pipe backpressure, not lost.
- **MCP mode** is **stateful**, not a byte relay. It drives the official MCP SDK's
  `StreamableHTTPServerTransport` as a bare adapter: a POST is correlated to the
  child's stdout response by JSON-RPC `id`; notifications/responses with no `id`
  return `202`; server-initiated messages flow out over the GET SSE stream. The SDK
  mints the `Mcp-Session-Id`. There is one MCP session per child (a loopback bridge
  is a 1:1 user→agent pipe).

## MCP mode details

Add the printed `http://127.0.0.1:PORT/mcp` URL under Thunderbolt → **Add MCP
Server**. The face enforces the same Origin allowlist as ACP (the MCP spec
requires Origin validation to defend against DNS-rebinding), answers CORS
preflight, caps request body size, and binds `127.0.0.1` by default.

Server-initiated requests and notifications use the GET **SSE** stream, which is
full-fidelity on localhost. Plain request/response tool calls (the common case)
work everywhere; only server-push degrades over a cloudflared quick tunnel (see
below).

## Tunnel (mcp only)

`--tunnel` exposes the MCP face over a public
`https://<random>.trycloudflare.com/mcp` URL by spawning
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(it must be on your `PATH`).

Because a public URL fronts a privileged local server, the tunnel makes a
**bearer secret mandatory**: the bridge auto-generates a strong secret, requires
`Authorization: Bearer <secret>` on **every** request, and prints the secret to
**stderr only** — never in the URL or a query string. Paste both the URL and the
bearer into Thunderbolt → Add MCP Server:

```
thunderbolt-stdio-bridge ready (MCP over cloudflared tunnel)
  Server:     npx
  Public URL: https://random-words-1234.trycloudflare.com/mcp

In Thunderbolt → Add MCP Server, paste:
  URL:           https://random-words-1234.trycloudflare.com/mcp
  Authorization: Bearer <secret>
```

Notes:

- **`--tunnel` requires `--mode mcp`.** It is **rejected with `--mode acp`**: ACP
  carries no client auth, so a public tunnel would be an unauthenticated
  remote-code primitive. ACP stays localhost-only.
- **Server-push/SSE degrades over quick tunnels.** Request/response tool calls work
  normally; server-initiated streaming may not arrive. Use localhost for
  full-fidelity SSE.

## Security

The server binds **`127.0.0.1` only** by default, so it's reachable solely from
your own machine.

That's not enough on its own: browser connections are **not**
same-origin-protected, and the bridge fronts a privileged local agent that can
read/write files and run commands (ACP) or invoke tools (MCP). Without a guard,
any web page open in a browser on your machine could connect and drive it. So
both faces accept a connection only when its `Origin` header is a known
Thunderbolt app origin:

- `https://app.thunderbolt.io` — production web app
- `tauri://localhost` and `http://tauri.localhost` — Tauri desktop/mobile webview
- `http://localhost:1420` — Vite dev server (web + Tauri dev)
- a **missing/empty** `Origin` — native and Tauri webviews routinely send none

In ACP mode a disallowed `Origin` is rejected during the WebSocket handshake
(HTTP `403`); a defense-in-depth check also closes any such socket with code
`1008`. In MCP mode a disallowed `Origin` gets `403` and the request is never
delegated to the transport.

- **Add an origin:** `--allow-origin <origin>` (repeatable) for dev or self-host.
- **Turn the check off:** `--allow-any-origin`. This lets **any** browser page on
  the machine drive your agent — only use it on a trusted dev/self-host machine.
  It prints a loud startup warning.
- **Tunnel auth:** with `--tunnel`, a mandatory bearer gates every request on top
  of the Origin check (see [Tunnel](#tunnel-mcp-only)).

## Logging & privacy

`thunderbolt-stdio-bridge` never logs message content. Log records are built from
an **allowlist of scalars** — there is no code path that copies a frame body into
a log line. Logged fields are limited to: direction, message kind, a fixed set of
known ACP/MCP method names (anything else collapses to `other`), a scalar
JSON-RPC id (long string ids are truncated), byte size, status, integer error
codes, and lifecycle events. The `Origin` header is sanitized to scheme + host
before logging.

Prompt text, tool arguments/results, file paths, tokens, and your command's argv
are **never** logged — even with `--verbose`. Dropped or malformed stdout lines
are logged by **byte size only**. The agent's own stderr passes through to your
terminal untouched.

## Troubleshooting

The bridge prints an actionable message to stderr and exits with a specific code:

| Exit  | When                                                                                                                                                       | Fix                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Clean shutdown (agent exited normally, or Ctrl-C with the agent gone).                                                                                     | Nothing — normal exit.                                                                                                                                                                    |
| `64`  | **Bad invocation.** Missing `--mode`, missing `--` separator, no command, an unknown option, an invalid `--port`, or `--tunnel` with `--mode acp`.         | Re-check the command. `--mode <acp\|mcp>` is required and the command goes after `--`, e.g. `npx thunderbolt-stdio-bridge --mode acp -- npx -y @zed-industries/claude-code-acp`.          |
| `69`  | **Agent or server problem.** `command not found` / `permission denied`, the agent **exited before it was ready**, port already in use, or a non-zero exit. | For "command not found", install the command / check your PATH. For early exit, run the command directly to see its error (its stderr also prints above). For port in use, omit `--port`. |
| `70`  | **Missing dependency.** `--tunnel` was set but `cloudflared` isn't on your PATH.                                                                           | Install cloudflared, or drop `--tunnel` to stay on localhost.                                                                                                                             |
| `130` | **Ctrl-C / `SIGTERM`.** You stopped the bridge.                                                                                                            | Nothing — expected interrupt.                                                                                                                                                             |

## Development

```bash
bun install
bun test
```

## License

MPL-2.0
