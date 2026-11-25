# MCP: a paired device speaks MCP to a machine

Status: design, 2026-11-23. Tracked in #2735.

An assistant that speaks the Model Context Protocol reaches a machine's terminals through Doriterm. It pairs like a
phone does and then talks MCP instead of herdr-core's own protocol. The host translates. Nothing else is new.

## What it is

- **An MCP client is a paired device.** It pairs with the existing offer (QR, link or typed code, with the same
  fingerprint check), lands in `devices.json`, and is revoked like any device. It has what every paired device has:
  the owner's reach on that machine.
- **MCP is one more stream on the existing session.** A session names `stream: "mcp"` in its encrypted handshake, as
  `push` and `roster` sessions name theirs. The relay cannot read it and does not change.
- **The host is the MCP server, and its tools are herdr-core's methods.** `terminal.list` is the tool
  `terminal_list`, and so on. The tool table is generated from `packages/protocol/schema/hc.openrpc.json`, the schema
  the client types already come from. A call is passed to herdr-core and its answer is passed back.
- **Off until switched on.** `doriface-host mcp on` on a machine, or the switch in Settings. `mcp off` closes every
  MCP session on that machine.

## User scenarios

**S1. An assistant on another computer.** I turn MCP on for my machine and open a pairing offer, as I would for a
phone. On the assistant's computer I run `doriface-host connect <link or code>` once. Then I paste this into the
assistant's MCP settings:

```json
{ "mcpServers": { "doriterm": { "command": "doriface-host", "args": ["connect", "--mcp", "<hostId>"] } } }
```

The assistant now lists my terminals, reads a screen, sends a message to an agent, or runs a command, with my rights
on that machine.

**S2. I want it gone.** Settings > MCP clients lists what is connected. **Disconnect** revokes that device: its
session closes at once and its key is refused from then on. `doriface-host devices revoke <id>` does the same.

**S3. Everything off.** `doriface-host mcp off`, or the switch. Every MCP session on that machine closes, and none
opens until I switch it on again. Paired devices stay paired.

## The seam

| Layer             | Where                                                    | Change                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handshake payload | `packages/crypto/src/payloads.ts` (`Stream`, `streamOf`) | `Stream` gains `"mcp"`: a session stream with no early bytes, never a pairing stream                                                                                                                      |
| Admission         | `apps/host/src/e2ee/authorize.ts` (`sessionPeer`)        | On `mcp`: refused while MCP is off; otherwise the keys the `push` stream admits, a paired device or a client member. A machine member is refused, as it is on `push`                                      |
| Dispatch          | `apps/host/src/gateway.ts` (`serveE2ee`)                 | `if (secure.stream === "mcp") return serveMcp(secure)`, beside `servePush`                                                                                                                                |
| Live sessions     | `apps/host/src/e2ee/sessions.ts`                         | An MCP session is registered like a push session, so the existing per-chunk check and `closeRevoked` end it when its device is revoked. One addition: `mcp off` closes the sessions whose stream is `mcp` |
| The switch        | `apps/host/src/state/mcp-switch.ts`                      | `mcp.json` in the state directory: `{ "version": 1, "enabled": false }`                                                                                                                                   |
| The server        | `apps/host/src/mcp/`                                     | Lines in, lines out; a method switch; `tools/call` forwards to the session's own `hc connect`, the same pipe an hc session gets                                                                           |
| The bridge        | `apps/host/src/commands/connect.ts`                      | `--mcp` dials with `stream: "mcp"` and pipes stdin and stdout, which is MCP's stdio transport                                                                                                             |

What stays untouched: herdr-core, the relay, the record layer, the hc stream (still a byte pump), pairing, the device
store, mesh records.

## Protocol

MCP revision `2026-07-28`, in its stdio framing: one JSON-RPC message per line, UTF-8, LF-terminated, at most
256 KiB. That revision is stateless: no `initialize`, each request names its protocol version in `_meta`, and the
server answers `server/discover`. The server never sends a request.

Served methods: `server/discover`, `tools/list`, `tools/call`. No resources, prompts, sampling or elicitation.

Tools are herdr-core's methods, with seven left out:

- `hello`, `rpc.discover`, `terminal.attach` and `events.subscribe`, which MCP's request and response shape cannot
  carry (the last two open a byte stream);
- `server.stop`, `server.restart` and `machine.rm`, which take the core or a machine away from its owner. This is the
  one difference from a paired device.

`machine.exec` and the file methods stay, as for any paired device. A tool's name is the method with `.` replaced by
`_`, its description is the schema's summary, and its input schema is built from the method's parameters. A
herdr-core error comes back as a tool error with its `kind` and message.

Authentication is the Noise session. There is no token and no HTTP endpoint, so MCP's OAuth flow, which the
specification defines for HTTP transports, does not apply.

## Safety

- The trust decision is pairing, as for every device. A person compares the host's fingerprint, the offer lasts
  10 minutes and works once.
- An MCP client is owner-equivalent on the machine it paired with, except that it cannot stop or restart the core or
  remove a machine. It can run commands and write files, because a paired device can. The pairing screen for an MCP
  client says so.
- Tool results are whatever a program printed. An assistant that reads a terminal can be told things by that
  terminal. This design does not filter or approve calls: the remedy is not to pair an assistant you would not hand a
  shell to, and to disconnect one that misbehaves.
- Tool names, descriptions and schemas come from the build, never from terminal data.
- Remote reach is the relay session only. No listener, port or ssh is added.
- Off by default per machine. `mcp off` and device revoke both close live sessions at their next chunk, and at once
  when the host is told through its control socket.

## Rollout

| PR   | Lands                                                                                                                                                     | Tests                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The `mcp` stream, the switch, `doriface-host mcp on\|off\|status`, a server that answers `server/discover`                                                | The stream by key matrix; off by default refuses before any answer; `mcp off` and a device revoke written by another process each close an open session; an unreadable switch file refuses MCP and leaves hc sessions alone; oversize, non-UTF-8 and non-object lines close 4400 |
| 2    | Tools generated from the herdr-core schema, and `tools/call`                                                                                              | The generated table is checked in CI like the client types; each of the seven excluded methods is absent and refused by name; a call reaches a real `hc` and returns its result; an hc error is a tool error; the hc pipe dying mid-call fails that call and ends the session    |
| 3    | `doriface-host connect --mcp`                                                                                                                             | Against the relay: pair, then `server/discover` and a tool call through the bridge; revoke closes it                                                                                                                                                                             |
| 4    | Web: the Settings switch, the list of connected MCP clients, Disconnect, and the attach dialog (pairing code and QR, waiting, connected, the config line) | Browser tests against the fake relay                                                                                                                                                                                                                                             |
| Docs | Setup on the landing site: turn on, pair, paste the config                                                                                                |                                                                                                                                                                                                                                                                                  |

## Code quality

- One table, generated. `tools/list` and the dispatcher read the same generated file, and a CI check fails when it is
  stale, as `gen:api:check` does today.
- The dispatcher is a switch over that table. A method that is not in it is unreachable.
- The server takes its line link, its hc pipe and its clock as arguments, so tests run on in-memory links with no
  sleeps.
- No MCP code is imported by the hc stream's path.
- Each pull request adds its changelog fragment, and the contract gains its change-log entry with the wire change.
