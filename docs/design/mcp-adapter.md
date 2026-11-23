# Doriterm MCP adapter: the hosted web app attaches to the mesh as an MCP client

Status: design, 2026-11-23. Built in the order of section 5.1, tracked in #2735.

The question: can the hosted web app attach to the mesh as an MCP client through a thin adapter over the websocket
and API that exist today, safely, and what do pairing and the rest look like.

The answer in one line: the web app is the MCP client, a mesh machine is the MCP server, and the adapter is the piece
that makes the machine's existing session speak MCP. The other direction (an outside MCP host reaching the mesh) is
open question 2. A code-execution tool is out of scope.

## Summary

- Feasible: yes. The seam already exists. Every session to a machine names a `stream` inside its encrypted
  handshake, and the host dispatches on it. MCP becomes a fifth stream, `"mcp"`, beside `hc`, `mesh`, `push` and
  `roster`. The relay, herdr-core, the record layer and the mesh records do not change.
- "Thin" holds for the wire and fails for policy. Today every way into a machine is owner-equivalent: the host
  pipes a client's bytes to herdr-core with no method check. An MCP attach is the first way in that is weaker than
  an owner, so the adapter has to be the place that decides what a call may do. That part is new code on the host.
- Where it runs: on the mesh machine, inside the end-to-end encrypted boundary. A browser-side adapter cannot
  enforce anything against the browser that runs it. An edge adapter would have to read plaintext, which ends
  "the relay sees ciphertext only".
- Pairing: a new, scoped kind of key called a grant. It opens only the `mcp` stream on the machine that approved
  it, carries scopes and an expiry, and is revoked on that machine in one step.
- Safety rests on four things enforced on the host: a closed tool table, scopes per grant, an approval by a
  person for every call that changes something, and an audit line per call.
- First pull request: the `mcp` stream and the grant store exist, the stream is off by default, and it answers
  only `server/discover`. No tool is reachable yet.

## User scenarios

Each scenario names what the person sees. The design sections refer back to them as S1 to S6.

**S1. An assistant inside my own browser.** I am already a member of the mesh in this browser. I turn on an agent
panel and pick what it may do: read my agent terminals in two spaces and send them messages. The panel gets a
session grant that lasts until I close the tab. When the assistant wants to send text to a terminal, the page
shows me the exact text and the terminal, and I confirm. The grant protects me from the model. It does not protect
me from this browser, which holds an owner key anyway.

**S2. A browser I do not fully trust.** I am at a work laptop. I do not want it to hold a key that is a shell on
every machine I own. On my own machine I open "Attach an MCP client", choose read access to one space and
"send needs my approval", and get a QR code. The laptop opens it, both screens show the same six digits, I
approve, and the laptop gets a 30-day grant on that one machine. It can watch the agents and ask to nudge them.
It can never open a raw terminal, read a file outside the folders I picked, or reach another machine.

**S3. A call that changes something.** The client on the laptop calls `terminal_send`. The machine holds the call
and shows a pending approval to every owner client connected to it and to its own terminal: which grant, which
terminal, the exact text. I approve on my phone. The laptop's retry completes, once. If I do nothing for two
minutes the call is refused and nothing was typed.

**S4. I lose the laptop.** On any owner client I open Settings > Agents on that machine and remove the grant, or I
run `doriface-host mcp revoke <id>`. The laptop's open session closes at its next line with 4401, and its key is
refused from then on.

**S5. Everything off.** Something looks wrong. `doriface-host mcp off` closes every MCP session on that machine and
refuses new ones before they are answered. Grants stay on disk, so `mcp on` restores them. MCP is off on every
machine until someone turns it on.

**S6. Expiry and re-pairing.** After 30 days the grant stops working and the client says "this grant ended on
<date>: ask for a new one". A new offer from the owner renews it. A revoked key is never accepted again, so a
revoked client pairs with a fresh key.

## 1. Can it be a thin adapter over the existing websocket and API

Yes, with one honest limit stated in 1.3.

### 1.1 The seam

Paths are in the Doriterm repository at `dev` `3bcab50b`.

| Layer                            | Seam                                                                                                                          | What changes                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Handshake payload                | `packages/crypto/src/payloads.ts:61` (`Stream`), `:85-93` (`streamOf`), `:64` (`takesEarly`), `:70-71` (`encodePairingHello`) | `Stream` gains `"mcp"`. It takes no early bytes, as `push` and `mesh` do. A pairing hello may say `"stream":"mcp"`                             |
| Host admission                   | `apps/host/src/e2ee/authorize.ts:37-64` (`sessionPeer`), `:8-12` (`Peer`)                                                     | An `"mcp"` branch that consults only the grant store and returns a new peer kind, `agent`. Every other branch refuses a key that holds a grant |
| Host dispatch                    | `apps/host/src/gateway.ts:212-218` (stream dispatch in `serveE2ee`)                                                           | One more line: `if (secure.stream === "mcp") return serveMcp(secure)`, shaped like `servePush` at `:249-257`                                   |
| Live sessions                    | `apps/host/src/e2ee/sessions.ts:170-173` (`authorizes`), `:94-102` (`guardPush`)                                              | Authorization becomes a function of key and stream, and `guardMcp` re-checks the grant for every line, both ways                               |
| A line-based stream on a session | `apps/host/src/push/push-stream.ts:69-119` (`servePushStream`)                                                                | The model for `serveMcpLines`: decode UTF-8, split on LF, bound the line, one handler per line                                                 |
| The host's own calls to its core | `apps/host/src/mesh/hc-machines.ts:132-148` (`openOnCore`, `spawnHcLink`), used by `apps/host/src/push/core-feed.ts:97-116`   | The adapter makes its herdr-core calls over one such connection, with typed `connection.call(...)`                                             |
| Web: opening a non-hc stream     | `apps/web/src/push/push-route.ts:120-142` (`openPushLink`)                                                                    | `openMcpLink` is the same function with `stream: "mcp"` and the grant's key                                                                    |
| Web: transport seam              | `packages/client/src/link.ts:8-18` (`ByteLink`)                                                                               | The MCP client reads and writes lines on a `ByteLink`, as `HcConnection.open` does at `packages/client/src/connection.ts:118`                  |
| Wiring                           | `apps/host/src/host.ts:139-177` (`createGateway` options; `push` at `:142`)                                                   | An `mcp` option beside `push`                                                                                                                  |

### 1.2 What stays untouched

- **herdr-core and its protocol.** No new method, frame kind or socket. The adapter is one more client of the core.
- **The relay.** `stream` is inside the Noise payload, which the relay cannot read. The transport contract already
  says a new stream needs no relay change (the push stream, v1.7).
- **The record layer and the handshake.** Same Noise IK and IKpsk2, same session kinds `0x01` to `0x03`, same
  close codes.
- **The hc stream.** It stays a byte pump. No method policy is added to it, so the passthrough rule of
  `docs/architecture.md` section 4 still holds.
- **Mesh records and the view.** A grant is not a mesh record. No record type, card kind or `mesh.json` format
  changes, so no cohort gating is needed.
- **Device pairing and mesh joins.** Their offers, links and ceremonies keep their behaviour.

### 1.3 The limit: thin on the wire, a real policy layer on the host

`docs/design/client-mesh-member.md` section 4 states the fact this design starts from: a client on the hc stream
is owner-equivalent, because the gateway forwards plaintext to herdr-core with no method policy. The only check
on that stream is the first line (`apps/host/src/e2ee/first-line.ts:38-42`). A codec that translated MCP calls
into hc calls for the same key would therefore add no safety at all.

So the adapter terminates MCP on the host and owns four things the code base does not have today: a grant
store, a closed table of tools, a decision function per call, and an audit log. Sections 2 to 4 specify them.
They are small and separate from the byte pump, but they are new.

## 2. Architecture

### 2.1 Where the adapter runs

| Place                            | Verdict                                     | Reason                                                                                                                                                         |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The mesh machine, in `apps/host` | chosen                                      | It is the only place that both sees plaintext and can refuse a call the client is not allowed to make. Revocation and audit sit next to the thing they protect |
| The browser                      | rejected as the adapter, kept as the client | A page can wrap `HcConnection` in MCP tools in an afternoon, but the page still holds an owner-equivalent session. Policy in the page is advice                |
| An edge worker beside the relay  | rejected                                    | It would hold keys and read every call. The product's promise is a relay that sees ciphertext only                                                             |

### 2.2 Who is client and who is server

```
hosted web app (browser)                         mesh machine
+---------------------------+                    +---------------------------------------------+
| MCP client  (McpSession)  |                    | apps/host                                   |
|   lines on a ByteLink     |                    |   serveMcp: MCP server                      |
| SecureLink, stream "mcp"  |== relay, Noise ====|   grants, policy, approvals, limits, audit  |
| grant key (X25519)        |   ciphertext only  |   dispatch -> one hc connection -> core     |
+---------------------------+                    +---------------------------------------------+
```

- The web app is the MCP client. It opens one MCP session per machine it holds a grant on.
- Each machine runs one MCP server, named `doriterm`, for its own core only.
- The server never calls the client. This matches the current MCP revision, where servers do not initiate
  requests (2.4).

### 2.3 Transport

MCP's two standard transports are stdio and Streamable HTTP, and the specification allows custom ones. It says a
custom transport over a reliable byte stream should reuse the stdio framing. That is what this design does:

- One JSON-RPC message per line, UTF-8, LF-terminated, no embedded newlines, on the session's plaintext.
- A line is at most 256 KiB including its LF in either direction. A longer line, a line that is not a JSON object,
  or invalid UTF-8 closes the session with 4400, as the push and mesh streams do.
- Cancellation is `notifications/cancelled`, as on stdio.
- Authentication is the Noise session itself. MCP's OAuth flow is defined for HTTP transports, and the
  specification tells other transports to follow the best practice of their own protocol. Here both ends are
  authenticated by static keys before the first line, and there is no bearer token anywhere to steal.
- An MCP session is not resumable (contract v1.11 resume). A dropped socket ends it, the client opens a new one
  with a fresh handshake, and in-flight calls are re-issued under the rule in 4.4.

### 2.4 Protocol revision

The adapter implements MCP revision `2026-07-28` and no earlier one. Three properties of that revision shape the
design:

- It is stateless. There is no `initialize` handshake. Every request carries its protocol version and the
  client's capabilities in `_meta`, and the server must implement `server/discover`.
- Servers must not send requests. When a server needs something from the person, it answers `tools/call` with an
  `InputRequiredResult` and the client retries the call. Approvals use this (4.3).
- Change notifications come through one long-lived `subscriptions/listen` request.

A client that speaks only an older revision gets a protocol-version error and nothing else.

### 2.5 Tools

One table in code drives `tools/list`, the dispatcher, the scope check, the audit names and the generated
TypeScript declarations (section 6). Tool descriptions are constants shipped with the host build. Nothing a
program printed, and no terminal name, title or label, ever becomes part of a tool name or description.

| Tool                      | herdr-core call                                           | Scope            | Default mode |
| ------------------------- | --------------------------------------------------------- | ---------------- | ------------ |
| `terminals_list`          | `terminal.list`                                           | `terminals:read` | allow        |
| `terminal_get`            | `terminal.get`                                            | `terminals:read` | allow        |
| `terminal_read`           | `terminal.read`, at most 2,000 history lines              | `terminals:read` | allow        |
| `terminal_wait`           | `terminal.wait`, at most 120 s                            | `terminals:read` | allow        |
| `templates_list`          | `templates.list`                                          | `terminals:run`  | allow        |
| `terminal_run`            | `terminal.run` with a template name from the grant's list | `terminals:run`  | ask          |
| `terminal_send`           | `terminal.send`, never with `force`                       | `terminals:send` | ask          |
| `terminal_keys`           | `terminal.keys`                                           | `terminals:send` | ask          |
| `terminal_interrupt`      | `terminal.interrupt`                                      | `terminals:send` | ask          |
| `terminal_end`            | `terminal.kill`, then `terminal.rm` when asked            | `terminals:end`  | ask          |
| `file_read`               | `file.read` inside the grant's folders                    | `files:read`     | allow        |
| `file_write`, `file_edit` | `file.write`, `file.edit` inside the grant's folders      | `files:write`    | ask          |
| `exec`                    | `machine.exec`, at most 60 s                              | `exec`           | always ask   |

Rules the dispatcher applies to every call, whatever the scope:

- **Terminal selector.** A grant names the terminals it reaches: the ones it started, the terminals of chosen
  spaces (by the `herdr.space` label, `apps/web/src/workspace/placement.ts:5`), or all. A terminal outside the
  selector answers `not_found`, the same answer a terminal that does not exist gets. The check runs on every
  call, because a terminal address is a handle that can be guessed.
- **This machine only.** The `on` parameter is never forwarded, and a terminal argument that contains `/` is
  refused, because herdr-core reads `machine/t7` as a terminal on another machine.
- **The person's own terminals.** A terminal the person opened from the window is named `opened-*`
  (`apps/web/src/terminal/opening-attach.ts:14`). No grant types into it, interrupts it or ends it.
- **A blocked program.** When a terminal's status is `blocked`, its program is waiting on a permission dialog.
  `terminal_send` and `terminal_keys` are refused there, so an MCP client can never answer another agent's
  permission prompt. That stays a person's act through the existing banner and push path.
- **Terminals it started.** `terminal_run` adds the label `mcp.grant=<grant id>`. `terminal_end` on a terminal
  without that label always asks, whatever the grant's mode.

### 2.6 Resources

| URI                                    | Content                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `doriterm://machine`                   | this machine's name, its OS from the host-info document, host and core versions |
| `doriterm://terminals`                 | the terminals inside the grant's selector, as `terminals_list` returns them     |
| `doriterm://terminal/{address}`        | one terminal's facts                                                            |
| `doriterm://terminal/{address}/screen` | the screen as text                                                              |

`subscriptions/listen` with `resourceSubscriptions` on these URIs is fed by one core event feed the host keeps
for all MCP sessions, as the push service keeps one (`apps/host/src/push/core-feed.ts:21-92`). It lands after the
tools (section 5).

The server offers no prompts. It asks for no sampling and no roots, which the current revision deprecates anyway.
It uses elicitation in form mode only, for the confirmation in 4.3.

### 2.7 What is deliberately not exposed

| Not exposed                                                      | Why                                                                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc.get`, `doc.set`                                             | Documents carry the mesh offer and approval requests. Writing `doriface-mesh-offer` mints an auto-admitting invitation. A grant that could write documents would be an owner |
| `machine.add`, `machine.rm`, `machine.rename`, `machine.connect` | They change which machines the core dials, and `machine.add` can dial over ssh. Remote reach in this design is relay sessions only                                           |
| `server.stop`, `server.restart`                                  | They end every program on the machine                                                                                                                                        |
| `terminal.attach`                                                | A raw terminal stream is a shell, and MCP has no shape for it. `terminal_read` and resource updates cover reading                                                            |
| `terminal.label`, `terminal.keep`, `terminal.put`                | Labels define a grant's selector, so a grant that could relabel could widen itself. The other two wait for a need                                                            |
| `terminal.send` with `force`                                     | It types into a blocked program, which answers its dialog                                                                                                                    |
| `rpc.discover`, any method by name                               | The dispatcher is a closed switch over the tool table. A method a newer core adds is unreachable until someone adds a row, the opposite of the hc stream on purpose          |
| Pairing, mesh and device commands, the push stream               | Membership and notification settings are an owner's                                                                                                                          |
| Other machines (`on`)                                            | Section 2.8                                                                                                                                                                  |

### 2.8 More than one machine

A grant covers the machine that approved it. A client that holds grants on three machines opens three MCP
sessions, one per machine, each under its own grant. Fan-out is a loop in the client. This is how the web app
already reaches members since the device-membership work: one relay session per member.

The alternative, one machine's adapter forwarding calls to other machines through its own lines, is decided in
open question 4.

## 3. Pairing

### 3.1 The principal: a grant

A grant is a row in `mcp-grants.json` in the host's state directory, mode 0600, written under the state lock, as
`devices.json` is (`apps/host/src/state/devices.ts:27-116`).

| Field                                  | Meaning                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `key`                                  | the client's X25519 public key, the Noise static of its MCP sessions                                                  |
| `id`                                   | the first 8 hex characters of the key's fingerprint, the handle `mcp revoke` takes (as `deviceIdOf`, `devices.ts:21`) |
| `name`                                 | what the client called itself, checked by the device-name rule                                                        |
| `kind`                                 | `device` or `session` (3.6)                                                                                           |
| `scopes`                               | each granted scope with its mode, `allow` or `ask`                                                                    |
| `terminals`, `folders`, `templates`    | the selector, the file roots and the template names                                                                   |
| `confirm`                              | who answers an `ask`: `owner`, or `self` for a session grant in the owner's own browser                               |
| `createdAt`, `expiresAt`, `approvedBy` | wall times and where it was approved (the machine's terminal, or the id of an owner client)                           |

One key has one role. A key that holds a grant is refused on `hc`, `push`, `roster` and `mesh`, and a pairing that
presents it as a device is refused. A key that is a mesh member's or a paired device's is refused on `mcp` and
cannot be granted (the existing `claimsKey` check, `apps/host/src/e2ee/accept.ts:255`). So "this key is weaker
than an owner" is a property of the key that no stream can widen.

### 3.2 The flow for a browser that is not a member (S2)

1. **The owner opens an offer on the machine.** `doriface-host mcp pair`, or Settings > Agents > Attach an MCP
   client in any owner client connected to that machine. The owner sets a ceiling: scopes with modes, terminals,
   folders, templates and a lifetime. The machine shows a QR code, a link and an 8-character typed code. The
   offer lives 10 minutes and is single use. The link is the existing pairing link with one more key, `&a=1`, as
   a mesh offer adds `&m=1`.
2. **The client asks.** The browser opens the link or types the code, creates its grant key (3.4), and runs the
   existing pairing handshake over the relay with `"stream":"mcp"`: IKpsk2 with the link secret, or CPace with
   the typed code. It then sends its request: its name, and the scopes it wants within what the offer allows.
3. **Both screens show one code.** The machine committed to a random value before it saw the client's, both
   derive a 6-digit code from the handshake hash and the two values, and each screen shows it. The copy says to
   compare by looking at the other screen or by a call, and never in the chat that carried the link.
4. **The owner approves, the client confirms.** The owner sees the name, the requested scopes and the code, may
   narrow the scopes, and approves. The approval must carry the code. The client's person taps "The codes match".
   The machine acts only when it holds both.
5. **The machine writes the grant.** It burns the offer first and stores the grant second, so a failed store
   never leaves a usable offer. It answers `granted` with the grant id, the final scopes and the expiry. From then
   on the client opens sessions with `"stream":"mcp"`.

The lines on the pairing session, using the mesh line codec and its bounds:

```
host   -> offer    { nonce, commit, ceiling }
client -> request  { name, scopes, terminals, folders, templates, lifetime, sas: Nj }
host   -> reveal   { Ni }                      client closes unless SHA-256(label || h || Ni) == commit
both      code = the 6 digits of packages/mesh/src/join/code.ts, with its own label
client -> confirm  { }   or   abort { }
host   -> granted  { id, scopes, terminals, folders, templates, expiresAt }   or   refused { reason }
```

This is the committed join code of `docs/design/device-mesh-membership.md` section 9 with a request in place of
a member card. `joinCommit` and `joinCode` (`packages/mesh/src/join/code.ts:10-21`) gain a label parameter so the
MCP code is domain-separated from the mesh join code.

Refusals that hold from the first build:

- A device pairing on an MCP offer, or an MCP request on a device or mesh offer, is closed with 4401 before any
  answer and is not counted as an attempt, as the two existing kinds refuse each other.
- A request above the ceiling is refused, and the offer is spent.
- The first request spends the offer, whatever happens after it.
- A session that drops before `granted` withdraws the pending request. The client asks for a new offer. There is
  no resume of a dropped pairing in the first build (open question 9).
- An owner client too old to show the code cannot approve: the machine accepts an approval only with the code.

### 3.3 The flow for a browser that is already a member (S1)

A member browser holds an owner-equivalent session, so a ceremony would add nothing. The page writes a request to
the `doriface-mcp-request` document on the machine: a nonce, a fresh grant public key, a name, scopes and
`kind: "session"`. The host answers in the same document with the grant id and expiry, as it answers the mesh
offer document today. Anyone who can write that document already reaches the machine's shells, so the request
grants nothing they lack. The grant's `confirm` is `self`: an `ask` is answered in the page, by the person, not
by the model.

### 3.4 Key material

| Key                     | Where                                                                                                                                                                            | Notes                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Grant key, X25519       | a device grant: IndexedDB, a non-extractable WebCrypto key where the browser can store one (`apps/web/src/connection/device-key.ts:5-9`, `:69-70`). A session grant: memory only | Separate from the device key and never the same key     |
| Link secret, typed code | the offer, 10 minutes, single use                                                                                                                                                | Same construction and attempt limits as device pairing  |
| Join code               | derived, shown, never stored                                                                                                                                                     | 6 digits, one try per offer                             |
| `requestState` key      | host memory, random at start                                                                                                                                                     | Authenticates approval state handed to the client (4.3) |

A browser that cannot hold a non-extractable key keeps raw key bytes, which a script in the page's origin can
copy. Such a browser gets session grants only.

### 3.5 Expiry, revocation, re-pairing

- **Expiry.** A device grant lasts 30 days from approval by default, 90 at most. A session grant lasts until its
  last session has been closed for 2 minutes, and 12 hours at most. A device grant unused for 14 days is
  suspended, and an owner resumes it with one tap. Expiry is checked on the handshake and again for every line.
- **Revocation.** `doriface-host mcp revoke <id>`, the owner client's Settings > Agents, or the document request.
  The row leaves the file, the key goes on a burned list, and the session closes with 4401 at its next line in
  either direction, as a revoked device's does (`apps/host/src/e2ee/sessions.ts:113-120`). A burned key is refused
  for any future pairing.
- **Re-pairing.** A new offer and the same ceremony. A client whose grant expired may keep its key, and the new
  grant replaces the old row. A revoked client makes a new key.
- **The machine leaves the mesh or is reinstalled.** The grant lived on that machine and goes with its state
  directory. Nothing else in the mesh ever knew the key.

### 3.6 Per-session and per-device grants

|                   | Session grant                                | Device grant                                |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| Who gets it       | a member browser, for its own assistant (S1) | a browser that is not a member (S2)         |
| How               | document request, no ceremony                | offer, code on both screens, owner approval |
| Key lives         | in memory                                    | in IndexedDB                                |
| Ends              | with the tab, 12 h at most                   | 30 days by default, or revoke               |
| `ask` answered by | the person in the same page                  | an owner, somewhere else                    |
| Protects against  | the model, and what it read                  | the model, and the browser itself           |

### 3.7 Managing grants as an owner

The host publishes a `doriface-mcp` status document: whether MCP is on, the grants with their scopes and
last-used times, pending pairings and pending calls, and the last 50 audit entries. Owner clients read it the way
they read `doriface-mesh`, with the same forward-compatible reading rule. They answer through two request
documents, `doriface-mcp-request` (open an offer, mint a session grant, revoke, resume) and
`doriface-mcp-approval` (approve or deny a pending pairing or call), modelled on
`apps/host/src/mesh/approval-doc.ts:8-25`. The machine's own CLI does the same through the control socket
(`apps/host/src/control.ts:7-11`). A grant can do none of this, because no tool reads or writes documents.

## 4. Safety

### 4.1 Threat model

| Threat                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stolen browser session, device grant (S2)                              | The thief has the grant's scopes on one machine until expiry or revoke. `ask` calls still need an owner elsewhere. No raw terminal, no other machine, no documents. The owner sees last-used times and the audit tail, and revokes in one step                                                                                                                                                                                                    |
| A stolen browser session, member browser (S1)                            | The browser already holds an owner key. MCP adds nothing to what a thief gets. Stated plainly, as the existing threat model states it for script injection                                                                                                                                                                                                                                                                                        |
| Script injection in the web app's origin                                 | It can use a grant key while the page is open. It cannot copy a non-extractable key out. It can answer a `self` confirmation, which is why `self` exists only for session grants in a browser that is already an owner                                                                                                                                                                                                                            |
| A malicious or compromised MCP server (a mesh machine)                   | The client pins the machine's Noise key from pairing, so only that machine can answer. Even so the client treats everything it returns as untrusted: it shows only tools it knows by name, ignores tool annotations (the specification says they are untrusted unless the server is trusted), declares no sampling and no URL-mode elicitation, follows no link from a result, and never sends one machine's result to another machine on its own |
| Prompt injection through tool results                                    | Terminal screens and files are whatever a program printed. The design assumes the model will be told to misbehave. So: reading scopes cannot change anything, every changing call shows a person the exact arguments as the host computed them, results carry no instructions field, control characters are stripped, and results are capped at 64 KiB                                                                                            |
| Tool poisoning through names                                             | Tool names, descriptions and schemas are build constants. Terminal names, titles and labels appear only inside results                                                                                                                                                                                                                                                                                                                            |
| Command execution on another machine                                     | `on` is never forwarded and `machine/t7` addresses are refused (2.5). A grant reaches one core                                                                                                                                                                                                                                                                                                                                                    |
| An MCP client answers an agent's permission prompt                       | `terminal_send` and `terminal_keys` refuse a blocked terminal, and `force` is never set                                                                                                                                                                                                                                                                                                                                                           |
| A grant widens itself                                                    | No tool writes labels, documents or the grant file. Scopes change only by an owner's act                                                                                                                                                                                                                                                                                                                                                          |
| The arguments change between approval and execution                      | An approval is bound to a hash of the tool name and canonical arguments. A retry with other arguments is a new call with a new approval                                                                                                                                                                                                                                                                                                           |
| A forged or replayed approval state                                      | `requestState` is authenticated by the host with a key the client never sees, names the grant, the call and an expiry, and is consumed once. The specification requires this when the state influences authorization                                                                                                                                                                                                                              |
| Approval fatigue                                                         | At most 3 pending approvals per grant. Further `ask` calls are refused until one is decided. An approval names one call, never "all calls like this"                                                                                                                                                                                                                                                                                              |
| A leaked pairing link or code                                            | 10 minutes, single use, 10 answered typed-code attempts, and the code on both screens. A stranger who uses it shows the owner a request with a code that is not on the screen they expect                                                                                                                                                                                                                                                         |
| The relay sits in the middle of a pairing                                | As for a mesh join: it cannot finish the handshake without the secret, and if it also holds a leaked code, the client's own confirmation against the machine's screen catches it                                                                                                                                                                                                                                                                  |
| A host downgraded to an older build reads an MCP offer as a device offer | `pairing.json` advances its version (`apps/host/src/state/pairing.ts:16-17`) when it gains the offer kind, so the older reader refuses the file                                                                                                                                                                                                                                                                                                   |
| A flood of calls                                                         | Per-grant and per-machine limits (4.5). The relay's own caps still apply to the upgrade                                                                                                                                                                                                                                                                                                                                                           |
| The audit log is edited                                                  | A process running as the same user can edit it. The log is evidence for the owner. It is no defence against a compromised machine, which is out of scope as it is today                                                                                                                                                                                                                                                                           |

### 4.2 Scopes

Least privilege is the default: an offer starts with `terminals:read` on the terminals the client starts, and the
owner adds from there.

| Scope            | Grants                                             | May be set to `allow`                          |
| ---------------- | -------------------------------------------------- | ---------------------------------------------- |
| `terminals:read` | list, facts, screen text, wait                     | always allow                                   |
| `terminals:send` | send text, press keys, interrupt                   | yes, per grant                                 |
| `terminals:run`  | start a named template                             | yes, per grant                                 |
| `terminals:end`  | end terminals the grant started. Others always ask | yes, for its own terminals                     |
| `files:read`     | read text files inside the chosen folders          | yes                                            |
| `files:write`    | write and edit inside the chosen folders           | yes                                            |
| `exec`           | run a command without a terminal                   | never. Offered only from the machine's own CLI |

File paths are resolved to their real path on the host and must fall inside a granted folder. The host's state
directory and herdr-core's configuration and state directories are refused always. A residual is stated here: the
check and the read are two steps, so a program that can write inside a granted folder can race a link into it.
Folders are therefore empty by default, and the approval copy says a granted folder is readable in full.

### 4.3 Approval for calls that change something

A call whose scope mode is `ask` goes through MCP's multi round-trip pattern:

1. The client sends `tools/call`. The host checks scope, selector and limits, creates a pending call, and answers
   with an `InputRequiredResult` that carries `requestState`.
2. For `confirm: owner`, the pending call appears in the `doriface-mcp` document and on the machine's terminal:
   the grant's name, the tool, and a summary the host rendered from the arguments (the terminal's name and
   program, the exact text or keys, the command line, the path and size). An owner approves or denies. The client
   retries with the same `requestState`. The host holds each retry for up to 20 seconds, so a client that retries
   at once does not spin, and answers "still pending" or the result.
3. For `confirm: self`, the same answer also carries one form-mode elicitation with the host-rendered summary.
   The page shows it to the person and retries with their answer. The model never sees a control it can press.
4. A pending call expires after 120 seconds. A denied or expired call returns a tool error and nothing ran.

`exec`, and `terminal_end` on a terminal the grant did not start, ask every time. Push notices for pending calls
are open question 6.

### 4.4 Exactly once

Every changing tool takes a required `call_id` the client generates. The host keeps the outcome of each
`(grant, call_id)` for 10 minutes. A repeat gets the stored outcome and never runs again. A call that was cut
while herdr-core was running it is recorded as `indeterminate` and is not run again either: the client is told to
read the terminal and decide. This is what makes a retry after a dropped session safe.

### 4.5 Rate and size limits

| Limit                    | Value                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Calls per grant          | 120 per minute                                                                                |
| Changing calls per grant | 20 per minute                                                                                 |
| `exec` calls per grant   | 6 per minute                                                                                  |
| Concurrent calls         | 4 per grant, 16 per machine                                                                   |
| Pending approvals        | 3 per grant                                                                                   |
| MCP sessions             | 2 per grant, 8 per machine, inside the relay's 32-session cap and the plan's `sessions` limit |
| Result size              | 64 KiB of text per call, with `truncated` and how to continue                                 |
| Bytes returned per grant | 4 MiB per minute                                                                              |
| Line size                | 256 KiB                                                                                       |
| `terminal_wait`          | 120 s. `exec`: 60 s                                                                           |

A refused call is a tool error with `retry_after_ms`. Five refusals in one minute close the session with 4429.
The counters run on the injectable `Clock` the mesh code uses (`apps/host/src/mesh/clock.ts:2-5`), so tests drive
time themselves.

### 4.6 Audit log

The host appends one JSON line per call to `mcp-audit.jsonl` in its state directory, mode 0600: time, grant id,
session, tool, the target terminal or path, the decision (allowed, refused and why, asked and who approved,
denied, expired), byte counts, duration and the error kind. For `terminal_send`, `terminal_run` and `exec` it
also keeps the first 200 characters of the text or command, because that is what an owner must be able to review.
It never keeps results or file contents. Pairings, revokes, `mcp on` and `mcp off` are lines too. The file rotates
at 8 MiB, four files kept. `doriface-host mcp log` prints it, and the status document carries the last 50 lines.
The code base has no audit log today, so this is new.

### 4.7 Kill switch

| Switch                                      | Effect                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `doriface-host mcp off` (the default state) | Closes every MCP session with 4401 and refuses new ones before any answer. Grants stay                                                      |
| `doriface-host mcp revoke <id>`, or `--all` | Ends one grant, or all of them                                                                                                              |
| Plan policy                                 | `mcp` becomes a feature a policy document can withhold (`packages/policy/src/policy.ts:20`)                                                 |
| An older host                               | Refuses the unknown stream at the handshake (4400). The client says the machine needs an update, and nothing else happened                  |
| Unreadable state                            | If the grant file cannot be read, every MCP session closes and none is admitted, as `LiveSessions` does for devices (`sessions.ts:136-162`) |

### 4.8 Relay only

Every MCP session is a relay session, as every web session is since the direct path was switched off. The adapter
adds no listener, no HTTP endpoint and no port. It never starts ssh and exposes no call that does.

## 5. Rollout and open questions

### 5.1 Pull requests

Each is small enough to review in one sitting and lands with its acceptance tests. Tests use the tools the
repository has: the in-memory link pair, the fake core, the fake relay and the fake clock
(`apps/host/src/mesh/testing/fake-clock.ts`), with no sleeps.

| PR  | Lands                                                                                                                                                                                                                                          | Acceptance tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Stream` gains `"mcp"`. The grant store and `doriface-host mcp on\|off\|grants\|revoke`. The `mcp` branch of `sessionPeer`, per-stream authorization in `LiveSessions`, `serveMcp` answering only `server/discover`. Contract change-log entry | The role by stream matrix: a grant key is refused on `hc`, `push`, `roster` and `mesh`; member, client and device keys are refused on `mcp`. Off by default refuses before any answer. Virtual clock: a grant admitted at day 29 is refused at day 31 and its open session closes. Fault: a revoke written by another process closes the session at its next line; a corrupt grant file closes every MCP session. Over the real relay: a session with `stream:"mcp"` answers `server/discover`. An older host answers 4400   |
| 2   | The tool table and dispatcher with the read tools and resources. Selector, output caps, limits, audit                                                                                                                                          | A terminal outside the selector and a missing one give the same answer. `machine/t7` is refused. Virtual clock: the 121st call in a minute is refused and the bucket refills. One audit line per call, refusals included. Fault: the core connection dies mid-call (tool error, session stays, next call reconnects); a 300 KiB line closes 4400; `notifications/cancelled` ends a `terminal_wait`                                                                                                                           |
| 3   | Pairing: the MCP offer, the pairing stream lines, the code, approval from the CLI and the documents, the web's attach page                                                                                                                     | A device pairing on an MCP offer is refused, and the reverse. An approval without the code is refused. The owner narrows scopes and the grant has the narrowed set. A request above the ceiling spends the offer and grants nothing. Virtual clock: the offer ends at 10 minutes. Fault: the socket closes after `reveal` (nothing stored); a crash between burning the offer and storing the grant (offer gone, no grant). The older reader refuses the new `pairing.json`                                                  |
| 4   | Changing tools, approvals, `requestState`, `call_id`                                                                                                                                                                                           | Ask, approve, retry: the call runs once. Deny and expiry at 120 s (virtual clock) run nothing. A tampered or replayed `requestState` is refused. Changed arguments need a new approval. A blocked terminal refuses send and keys, `force` is never forwarded, an `opened-*` terminal is refused. Fault: the socket dies after the core call went out, and the retry with the same `call_id` gets the stored outcome; a host restart drops pending calls and the retry asks again; two approvers race and one decision stands |
| 5   | Web client: `McpSession`, `openMcpLink`, the grant key, Settings > Agents, the session grant for a member browser, a plain scoped panel                                                                                                        | Browser tests against the fake relay: pairing end to end at phone width, an unknown tool from the server is not shown, annotations change nothing, revoke on the owner closes the client within one call, `mcp off` shows the right sentence                                                                                                                                                                                                                                                                                 |
| 6   | `file_read`, `file_write`, `file_edit`, `exec`                                                                                                                                                                                                 | A path outside the folders and a link that leaves them are refused. The state directories are refused always. `exec` asks every time and is absent from web-made offers                                                                                                                                                                                                                                                                                                                                                      |
| 7   | `subscriptions/listen` on the resources                                                                                                                                                                                                        | A status change reaches a subscribed client once. Fault: the core feed drops and resumes with a fresh snapshot and no duplicate                                                                                                                                                                                                                                                                                                                                                                                              |

### 5.2 Open questions, each with a decision

1. **Is a model driving this in the first build?** The web app has no assistant today. Decision: build the client
   and a plain scoped panel a person drives, and design every rule as if a model were driving. Adding the
   assistant later changes no safety property.
2. **Should outside MCP hosts (a desktop assistant, a coding agent) reach the mesh too?** Decision: yes, later,
   through a local stdio entry on a machine (`doriface-host mcp serve --grant <id>`) that runs the same server
   loop. The specification says stdio servers take credentials from their environment, which fits a local grant.
   A public Streamable HTTP endpoint with OAuth is refused: something between the cloud client and the machine
   would have to read plaintext.
3. **One grant for the whole mesh, as a signed record?** Decision: no. A per-machine grant needs no record
   format change and is revoked by one file write on one machine. A mesh-wide grant would need a new record type,
   the cohort gate, and a revoke that only propagates.
4. **Reaching other machines through the approving machine.** Decision: not in the first build. When it is
   needed, add a `machines` allow-list to the grant and forward `on` only to machines whose line is a mesh line
   (`machine.via`, `apps/host/src/mesh/hc-machines.ts:29`), never to a machine reached by ssh. The cost to state
   then: the approving machine becomes the one point of policy and of failure for that grant.
5. **May an owner key open the `mcp` stream directly?** Decision: no. One principal per stream keeps the matrix
   small. A member browser mints a session grant in one request.
6. **Push notices for pending calls.** Decision: later. The push payload's kind set is closed in the contract, so
   a new kind is a contract change of its own. The first build shows pending calls in the app and on the
   machine's terminal.
7. **Should `terminal_send` default to `allow`?** Decision: no. Text sent to a shell is a command. An owner can
   switch one grant to `allow` for send on chosen terminals, and the approval copy says what that means.
8. **Support for older MCP revisions.** Decision: none. The only client in the first builds is ours.
9. **Resuming a pairing that dropped.** Decision: no. A new offer costs the owner ten seconds. The mesh join
   needed resume for one phone switching between two apps, and that case does not arise here, because the
   approver is on another device.
10. **Where the audit log goes.** Decision: the machine's state directory only. No copy leaves the machine.

## 6. Code quality

- **One table.** Tool name, scope, class (read, change, exec), input and output schema, description and the
  herdr-core call live in one typed table. `tools/list`, the dispatcher, the audit names, the client's allow-list
  and the generated declarations all read it. A check in CI fails when a generated file is stale, as
  `gen:api:check` does for the core's schema.
- **Packages follow the existing dependency direction.** A new runtime-free package holds the line codec, the
  tool table, the scope types and the transport-agnostic `McpSession` over `ByteLink`. `apps/host/src/mcp/` holds
  the grant store, the server loop, the dispatcher, the decision function, approvals, limits and audit.
  `apps/web/src/mcp/` holds the link, the grant key and the views. Nothing depends on an app.
- **The decision is a pure function.** `decide(grant, tool, arguments, terminalFacts)` returns allow, ask or a
  named refusal. It reads no file, clock or socket, so one table test covers every tool against every scope and
  mode, and each refusal test names the mistake it catches.
- **The dispatcher is a closed switch.** It never takes a method name from the wire. A new core method is
  unreachable until a row is added and reviewed.
- **Time is injected.** Limits, approval expiry and grant expiry take a `Clock` and a wall-time function, as the
  mesh offer service does (`apps/host/src/mesh/offer-doc.ts:18-25`). No test sleeps or polls.
- **State fails closed.** An unreadable grant file admits nobody. A file an older build must not misread gets a
  new version number.
- **Refusals are data.** Each has a stable kind and one sentence a person can act on, kept in one module.
- **The byte pump stays a byte pump.** No MCP code is imported by the hc stream's path, and a test asserts the hc
  stream's bytes are unchanged with MCP on.
- **Files stay small**, one responsibility each, in the size the neighbouring host modules keep.
- **Each pull request adds its changelog fragment** under the section the change belongs to, and the contract
  document gains its change-log entry in the same pull request as the wire change.

## 7. What was read

- This repository at `dev` `3bcab50b`: `docs/architecture.md`, `docs/transport.md` (contract v1.11.1),
  `docs/design/client-mesh-member.md`, `docs/design/device-mesh-membership.md`,
  `docs/design/browser-mesh-join.md`, `SECURITY.md`, and the source files cited above with their lines.
- herdr-core through its published schema in this repository (`packages/protocol/schema/hc.openrpc.json`) and the
  installed CLI's help.
- Model Context Protocol specification, revision `2026-07-28`, fetched 2026-11-23 from
  `modelcontextprotocol.io/specification/2026-07-28/`: transports, stdio, Streamable HTTP, message patterns,
  multi round-trip requests, subscriptions, authorization, discovery, tools, elicitation, the schema reference,
  the change log and the security best practices.
