# Devices and browsers are mesh members: membership, the web's join, relay-only transport

Status: revision 3 for the design gate, 2026-11-08. Issues #942 and #1381. Revision 2 (device membership) was folded
from revision 1's FIX_FIRST and was not yet re-reviewed when the scope widened. Revision 3 keeps revision 2's mechanism
(§5, §6 and §10 are revision 2's §2, §3 and §4, with their folds) and adds what #1381 and the owner's follow-up ask for:

1. **#942, device mesh membership.** A device that reached the mesh through any one member keeps seeing and opening
   every other online member when that member is offline. No single host is a point of failure for a device.
2. **#1381, the web joins the mesh.** The browser becomes a mesh member itself. It joins from the browser with a link
   or code that any member gives it, with no per-host pairing step. Every web connection goes over the relay.
3. **Comparing keys at a join.** What the joining side and the approving side each show, in what format, when, and what
   a mismatch does (§9).

This builds on [client-mesh-member.md](client-mesh-member.md) (revision 4, approved, host side merged in #956): the
`client` card kind, `AuthorizeIndex.client`, the per-stream matrix and the format-readiness gate already exist. This
design adds one session stream (`"roster"`), one derived value (the join code, §9) and no new trust root, record type or
card field.

## 1. The gap, measured

Measured on dev `a4a83d5c` with two real machines (#942, 2026-11-08). A and B are in one mesh, and a browser device is
paired with A only. Stopping A's host leaves B up, but the device shows B as "unknown". It cannot open a terminal there,
and every socket it opened went to A.

Three things are missing, all of them in the client or at its edge:

1. **Nothing makes a browser a member.** Since #956 the hosts accept a `client` member, both on the hc stream and as a
   join on a mesh offer (`serveJoin` admits `kind: "client"`, `apps/host/src/mesh/invite.ts`). But the web refuses a
   mesh link (`apps/web/src/pair/mesh-invite.tsx`: "It is not an invite for a browser"), and `doriface-host pair` stores
   a device in A's `devices.json` and nowhere else, so B has never heard of the device's key.
2. **Nothing tells the browser who the members are.** `MeshConnections.pair()` adds the paired host to the roster
   (#1331), and nothing adds the others (`apps/web/src/connection/mesh-connections.ts`).
3. **The web has a path that is not the relay.** `connect()` tries a saved direct (LAN) address before the relay
   (`apps/web/src/connection/connect.ts`, `openDirect`, #446). #1381 orders every web conversation onto the relay.

## 2. Vocabulary

- **Machine member**: a host in the mesh. It signs records, dials the mesh and serves hc.
- **Client member**: a browser, phone or desktop client in the mesh, with its own Ed25519 card (`kind: "client"`). It
  signs only its own card, never dials the mesh stream, and opens hc sessions to machine members.
- **Paired device**: today's device in one host's `devices.json`. After this design it is a step on the way to being a
  client member (§11), not a parallel identity.
- **Inviter**: the machine member that serves a join. A client member can ask its machine to open an invite, but the
  inviter is always a machine, because only machines sign records.

## 3. Two ways in, one membership

| how the browser arrives                               | path                                                                 | approval                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| **a join link or code from any member** (new default) | the existing mesh join on a mesh offer, with a `kind: "client"` card | always asked on the inviter, with the join code (§9) |
| **already paired with one host** (migration)          | the `"roster"` stream admits the paired key (§5)                     | none: the pairing already was the approval (§5, §11) |

Both end in the same state: the browser is a client member of the mesh, it holds a verified record bundle (§6), and it
dials every machine member over the relay (§8).

## 4. The web joins the mesh

### 4.1 Wire

The browser runs the join a machine runs today (`apps/host/src/mesh/join-dial.ts`, `join.ts`), with three differences:

- the session's static key is the browser's X25519 device key (§7), not a host Noise key;
- the card is `kind: "client"`, signed by the browser's own Ed25519 key, with `noisePub = devicePub =` the device key,
  `hcId: ""`, a `checkName` name, and the offer's `mesh`, `inviter` and `nonce`;
- the welcome is checked by `checkWelcome`'s rules adapted to a client: every record passes `door` in order; exactly
  one `found`, whose id is the offer's mesh; the inviter is a **machine** member of the view with the hostId and Noise
  key the browser dialled; the browser is a **client** member whose card holds its own sign key and device key.

The session is a pairing session (IKpsk2) over the relay: a link carries the inviter's hostId, Noise key and link secret;
a typed code runs CPace on a `?pair=<slot>` session, exactly as `mesh join <code>` does. The host side is `serveJoin`
unchanged except for the join code (§9), the plan rule (§5.2) and "client invites always ask" (§4.3).

After `done` the browser closes the join session and stores the bundle. It never keeps the mesh stream open: a client
does not sync (`sessionPeer` refuses a client on `"mesh"`).

### 4.2 Where the invite comes from

Any member can give one, and none of them is special afterwards:

| on                                       | the person does                              | what is opened                                                                                                                    |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| a machine, CLI                           | `doriface-host mesh pair`                    | a single-use mesh offer (10 minutes): link, QR, code                                                                              |
| any web member (browser, phone, desktop) | Settings > Mesh > **Add a browser or phone** | the same offer, opened on the machine this client is connected to, through the `doriface-mesh-offer` document with `client: true` |

`client: true` makes the offer one that **asks** (§4.3). The one-line Add a machine (#668) keeps its auto-admitting
offer for machines.

### 4.3 Client invites always ask

An offer opened for a browser never auto-admits. A link sent through a messenger can leak, and the browser's membership
is owner-equivalent on every machine (revision 4 §4). So `serveJoin` routes a `kind: "client"` card to the pending-join
decision even on an auto offer, and the decision shows the join code (§9). A machine card on an auto offer stays
auto-admitted, as today.

### 4.4 Join flow UX

| step | joining browser (phone or desktop)                                                                                                                                                                                                             | approving member (the inviter's CLI, or any web client connected to it)                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | opens the link (or scans the QR, or types the code on `/join`). Sees **Join this mesh**: the inviter's name, "This browser becomes a member and reaches every machine in the mesh". Name field prefilled from the device. One button: **Join** | nothing yet                                                                                                                                                                         |
| 2    | **Waiting for approval on _studio_**, and the join code `482 913` in large digits: "Check that _studio_ shows the same code"                                                                                                                   | a pending join appears: **Approve "Pixel 9" (browser)?** with the join code `482 913`: "Approve only if the joining screen shows the same code". **Approve** / **The codes differ** |
| 3a   | codes match, approved: **Joined.** The machine list opens and fills in as each member answers                                                                                                                                                  | "Pixel 9 joined the mesh"                                                                                                                                                           |
| 3b   | denied: **Not joined: _studio_ denied this browser.** "Ask for a new invite." The link is spent                                                                                                                                                | "Denied. The invite is spent; open a new one"                                                                                                                                       |
| 3c   | the offer expired, was used, or the inviter is unreachable: the existing sentences (`handshake.ts` `REASONS`), with "mesh pair" in place of "pair"                                                                                             | nothing                                                                                                                                                                             |

The browser never shows a host fingerprint to compare in this flow. A link already carries the inviter's key, and a
typed code proves it through CPace; §9 says why the join code replaces the comparison.

## 5. The `"roster"` stream

A session (kind `0x01`) whose hello says `"stream":"roster"`. It is a client's one conversation about membership after it
is in, and the way a paired device gets in. It uses the mesh line codec and its bounds unchanged
(`apps/host/src/mesh/lines.ts`, `line-parse.ts`):

```
host   -> offer   { mesh, inviter: <this host's signPub>, nonce }
device -> card    v2, kind "client", signed by the device's own Ed25519 key
           (or, from a client member only: leave { card })
host   -> records ... (the host's whole stored record set, batched as in a welcome)
host   -> done    { mesh }
host closes the session
```

The card is the one revision 4 §6 specifies (§4.1's card). The host verifies the card (`verifyCard`) and the offer
binding, and requires `kind === "client"` and `noisePub === devicePub === remoteStatic`. Then:

| who the session key is                                    | the host                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a current **client member** whose card has this `signPub` | sends the records (a refresh), and admits nothing. A `leave` signs the revoke of exactly this client (§10.4)                                                                                                                                                                                                                                   |
| a **paired device** of this host that is no member        | admits the card, then sends the records. In order: `admissionRefusal` (format readiness); the client branch of the rejoin and collision checks (below); then, **inside the admit's `mesh.json` transaction**, a re-read of this host's `devices.json` confirming the key is still paired; then it signs an `admit` exactly as `serveJoin` does |
| a machine member's Noise or device key                    | refused at the handshake: a machine syncs on `"mesh"`                                                                                                                                                                                                                                                                                          |
| a revoked or superseded key, or an unknown one            | refused at the handshake (4401)                                                                                                                                                                                                                                                                                                                |
| any key, while this host is in no mesh                    | `refused "this host is in no mesh"`: no mesh is founded for a paired device (a browser's join on an invite founds one, as `mesh pair` does today)                                                                                                                                                                                              |

### 5.1 The rejoin check for a client

`isRejoin` finds the holder with `index.member()`, which never answers for a client. The client branch uses
`index.client(card.devicePub)` instead:

- If the same `signPub` already holds that key, this is a refresh. This also covers two concurrent admissions of one
  device: the second becomes a refresh.
- If another signing key holds it, the card is refused (`KEY_HELD`).
- If the `signPub` is a member with another key, the card is refused (`ANOTHER_KEY`).
- `namedByAnother` applies unchanged.

`serveJoin` (§4) uses the same client branch, so a browser that retries a join whose welcome was lost gets the welcome.

### 5.2 The plan limits

- `machines` counts **machine** members only. `memberCount` today counts clients too
  (`apps/host/src/mesh/authorize-index.ts`); it becomes `machineCount` for this check, so admitting browsers never
  refuses the next machine with copy about machines.
- A client is counted against the **admitting machine's `devices` limit**: that host's paired devices plus the client
  members whose governing admit it signed (a paired device that became a client is counted once). A join or an
  auto-admission over that limit is refused with the existing `devices` sentence.

### 5.3 Why admitting a paired device without asking is not a new capability

A device paired with A already drives every member through A's hc, over mesh lines A dials for it. The hc stream is
owner-equivalent (revision 4 §4). Admission changes only _where_ that reach comes from: directly instead of through A.
It does not change _what_ the device can reach. That holds only while A is a member, so it is enforced (§10.1,
**admitter binding**). A browser that was never paired still asks (§4.3).

### 5.4 Old hosts

`decodeHello` refuses an unknown stream at the handshake (`packages/crypto/src/payloads.ts`). A device that meets an
older host learns "not supported" with no side effect, and keeps working through that host as it does today.

## 6. The browser's bundle

The browser keeps, per mesh, the records it verified. They go in IndexedDB next to its keys (§7), and are never sent
anywhere.

- **Anchor.** The first bundle is accepted only from the inviter it dialled with the key the link or code proved (§4.1),
  or, for a paired device, from the host whose Noise key it pinned at pairing (§5). The checks are §4.1's.
- **Refresh.** After any member's session opens, the browser runs the roster stream to that member, once per session
  open and at most once per 10 minutes per member. The member must already be a machine member of the held view, with
  the Noise key the session authenticated. Each record passes `door` against the **held** set before it is kept.
- **Merge** is a union with history retention. A response that omits a record cannot remove it, so a revoke the browser
  holds is never erased.
- **The roster** is the **machine** members of `viewOf(held)`, which excludes revoked members, superseded keys and
  clients, plus any paired member not in the view (an older host, §13). Each member becomes a `MemberTarget` with its
  `hostId`, the view's name, its view Noise key as `hostKey`, and no `directUrl` (§8). It is computed from the bundle, so
  a member that leaves the view leaves the roster with it.
- **Precedence.** A paired member wins over a view member with the same `hostId`: the paired key is the one the person
  checked. A view member never replaces a paired entry's key.
- **Settling (revision 4 §2's readiness rule).** A member that refuses the browser with 4401 has usually not yet synced
  the admit. For a member the browser knows from its view, that refusal is **not final**: it is not
  `DeviceNotPairedError` and never "Pair it again". Its store keeps the retry ladder and shows the member as "settling".
  The ladder ends only when the held view stops naming the member, or stops naming the browser.
- **Cold start never needs the inviter.** The held bundle names every member's key, so the browser dials them all in
  parallel. The first one to answer refreshes the bundle.
- **The browser revoked, or orphaned.** A held view in which the browser is no longer a member drops every view member,
  covering its card revoked and its admitter no longer a current machine member (§10.1). It shows "This browser was
  removed from the mesh" with **Join again**, and keeps only paired members (migration devices), which decide for
  themselves.

## 7. Browser key custody

| key                 | what                                    | where                                                                                                                                                                                                          |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device key (X25519) | the Noise static key of every session   | unchanged (`device-key.ts`): a **non-extractable** WebCrypto `CryptoKey` in IndexedDB where the browser can store one; 32 raw bytes where it cannot (WebKit, #1329)                                            |
| card key (Ed25519)  | signs this browser's card, nothing else | the same rule and the same store: a non-extractable WebCrypto Ed25519 `CryptoKey` where `generateKey` and the IndexedDB read-back both work (the `keepsStoredKeys` probe), else raw bytes with `@noble/curves` |
| bundle              | the verified records (§6)               | the same IndexedDB database, one entry per mesh                                                                                                                                                                |

- Both keys are created together on the first join, under the existing Web Lock, so two tabs make one identity.
- The app calls `navigator.storage.persist()` on join. An installed PWA is exempt from eviction; a browser tab is not
  (Safari can clear site storage after 7 days without a visit).
- **Storage cleared or evicted.** The browser has lost its identity: no keys, no bundle. It starts as a stranger and
  shows **Join a mesh**. It must join again with a new invite and gets new keys. Its old card stays a client member that
  nobody can use (the private key is gone). Every member's list shows it with its last session time, and the person
  removes it (§10.3). Nothing tries to recover the old identity.
- **Non-extractable is not "safe from the page".** A script running in the app's origin can use the key while the page
  is open. It cannot copy it out where WebCrypto holds it. Raw-byte storage (WebKit) can be copied by such a script. §12
  states this.

## 8. Relay-only transport

Every connection the web client makes to a member is a relay session: `connectRelayClient` to the member's hostId,
then Noise IK pinned to the member's key from the view.

- `connect()` drops the direct attempt for every web client: `openDirect` and its race, the saved `directUrl`, the LAN
  URLs a host sends in message 2 (`lanUrls`), and the per-member `directUrl` in `MemberTarget`. Saved settings keep
  parsing a `directUrl` (downgrade) and ignore it.
- **The one exception** is the desktop shell's `loopback` mode to the host on the same computer. It is a local socket
  authenticated by a token, not a network path, and it carries no device key (revision 4 §4). The shell reaches every
  other member over the relay.
- The join (§4), the roster stream (§5), hc sessions and the push stream all go over the relay.
- The status bar's path label says **Relay** on every web session. The Direct label and its reasons (#446) are removed
  from the web.
- **Proof** (§14): an e2e whose page refuses every WebSocket that is not the relay's origin, and still joins, lists the
  mesh and opens a terminal.

The relay-transport lane (the relay path's owner) contributes its rows to this section in this PR: relay reconnect and
backoff per member, the relay's per-session limits as seen from a client with N members, and the hub's behaviour when a
member's uplink is down. Until those land, the rows above are the contract the web side implements.

## 9. Comparing keys at a join

Today a mesh join asks a person to compare two 40-character fingerprints. The CLI `mesh join <link>` asks "join the mesh
of host H, fingerprint XXXX XXXX …?"; `mesh pair` asks "admit N H fingerprint XXXX XXXX …?"; the web's pending-join row
shows the joiner's fingerprint. People do not compare ten groups of hex reliably, and the joiner-side question checks
something the link already proved.

**The rule:** a comparison step names the trust problem it solves, or it is not in the flow.

| comparison                                | the problem it would solve           | decision                                                                                                                                       |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| joiner checks the inviter's key (link)    | a link from someone else's host      | **removed**: the link carries the key, and the session is pinned to it. The person trusts the sender of the link, which no fingerprint changes |
| joiner checks the inviter's key (code)    | a code that reached another host     | **removed**: CPace with the code proves the session reached the host that offered the code                                                     |
| approver checks the joiner                | a leaked invite used by someone else | **kept, as a 6-digit join code** shown on both sides                                                                                           |
| relay or account "vouches" for the joiner | —                                    | **not used**: the relay is outside the trust boundary (it holds no key that opens a session), so it cannot vouch                               |

**The join code.** Both ends of the join session compute it from that session's Noise handshake hash, which binds both
static keys, both ephemerals and the pairing psk:

```
code = uint32_be(HKDF-SHA256(ikm = handshakeHash, salt = "", info = "doriface/1.3 mesh join code", 4)) mod 1_000_000
shown as "482 913"
```

- A different session (someone else using the leaked link, or a relay in the middle) has a different handshake hash, so
  a different code. One offer allows one join session, so an attacker gets one try at a 1-in-10^6 match.
- Nothing new is sent: the host adds `code` to the pending join (`PendingJoin`, the mesh status document's pending
  entry, the `mesh-pending` control answer); the browser computes its own from its `SecureLink.handshakeHash`.

**What each side shows, and when:**

| surface                                          | when                                  | shows                                                                                                                                        | mismatch                                                                                                          |
| ------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| joining browser                                  | from the card send until the decision | "Waiting for approval on _studio_" and the code `482 913`, large, tabular digits                                                             | the approver denies; the browser shows "Not joined: _studio_ denied this browser. Ask for a new invite."          |
| approving web client (any client of the inviter) | while the join is pending             | name, kind (browser or machine), the code `482 913`, **Approve** / **The codes differ**. The joiner's long fingerprint stays under "Details" | **The codes differ** denies, spends the offer, and the row reads "Denied: the codes differed. Open a new invite." |
| `doriface-host mesh pair` (CLI)                  | when the join arrives                 | `admit "Pixel 9" (browser) code 482 913? Approve only if the joining screen shows the same code [y/N]`                                       | `N` denies, as today                                                                                              |
| `doriface-host mesh join` (machine CLI)          | while waiting                         | `waiting for approval on <host>: code 482 913` (the question about the inviter's fingerprint is removed for a link)                          | the inviter denies; the command prints the refusal, as today                                                      |
| a member's list, after the join                  | any time                              | each member's long fingerprint, as today (`mesh-rows.tsx`), for audit                                                                        | —                                                                                                                 |

No comparison is shown when nobody is asked: a paired device's admission on the roster stream (§5.3), a machine on an
auto offer (#668), and every refresh.

Device pairing (`doriface-host pair`, the web's `VerifyStep`) keeps its host-fingerprint check unchanged. It is the
legacy way in (§11), and changing it is outside this design.

## 10. Revocation, removal and leaving

### 10.1 Admitter binding

A client member is authorized only while the signer of its governing `admit` is a current **machine** member.
`indexOf` (`apps/host/src/mesh/authorize-index.ts`) leaves such a client out of `members`; its key then falls through to
the paired-device check, so only a host that paired it directly still accepts it. Every host derives this from the same
records, so no new record is needed. A `mesh revoke A` or `mesh leave` is itself a `mesh.json` write, so the index is
rebuilt at the moment it matters and `closeRevoked` closes the orphaned clients' sessions. The browser applies the same
rule to its held view (§6).

### 10.2 From the mesh

`doriface-host mesh revoke <name>` on any live member works today, and resolves a client by its name or hostId. As the
revoke propagates, `closeRevoked` closes the client's sessions on each member: after propagation, not instantly across a
partition (revision 4 §5).

### 10.3 Removing a browser from another member, and the roster update

Every member's mesh list shows client members in their own group, **Browsers and phones**, with the name, the last
session time this machine saw, and the copyable `doriface-host mesh revoke <name>` command (the same affordance machines
have, `mesh-rows.tsx`). When the revoke reaches a member:

- that member closes the browser's sessions (`closeRevoked`);
- every other browser's next refresh (§6) brings the revoke, and the removed browser disappears from their lists;
- the removed browser itself, on its next refresh from any member, sees a view without itself and shows "This browser
  was removed from the mesh" (§6). If it can reach no member, every session it tries is refused 4401, which for a
  browser whose view still names it is "settling" until the ladder ends; it ends at the first refresh that carries the
  revoke.

### 10.4 Leaving, from the browser

Settings > Mesh > **Leave this mesh**. The browser sends `leave` on a roster session to any machine member. The host
signs `revoke { signPubs: [this client's signPub], reason: "leave" }` only for the client that authenticated the session.
It refuses a `leave` whose card is not the session's own. Then the browser deletes its bundle, card key and device key.
If no member is reachable, the browser says so and offers **Forget this mesh here**: local deletion only, with the
sentence "The mesh still lists this browser until a member removes it" and the revoke command.

### 10.5 Unpairing a migrated device on its admitting host

This is revision 2's invariant on the host that auto-admitted a paired device: _a client member this host admitted on the
roster stream stays a member only while this host still pairs its key._ It is enforced in three places:

1. At admit time, by the `devices.json` re-read inside the admit transaction (§5). An unpair that lands between the
   handshake and the admit makes the admit refuse, and nothing is signed.
2. On `devices-changed` (the CLI's `devices revoke` and the app's revoke both send it). The running host signs a revoke
   for every client member whose governing admit is its own, that it admitted on the roster stream, and whose
   `devicePub` is no longer paired.
3. Once at start, which covers a revoke made while the host was down.

The sweep also runs after every admit. When `devices.json` cannot be read, the sweep **signs nothing** and logs why: a
revoke burns the key mesh-wide, and an unreadable file says nothing about what was removed. A browser that joined on an
invite (§4) is in no `devices.json`, so the sweep never touches it.

- **Unpair is only as fast as the admitting host.** If A is stopped or partitioned, an unpair on A signs nothing until A
  runs and reaches the others. Until then B keeps accepting the device. `devices revoke` of a device that is a client
  member says so: the membership ends when this host is running and reachable, and
  `doriface-host mesh revoke <name>` on any running member ends it now. It prints that line whether the host is running
  or not.
- **Unpair on a host that did not admit the device** removes only that host's paired entry. The device stays a client
  member and that host keeps accepting it as one; `devices revoke` there prints the same `mesh revoke` hint.
- **A burned key.** After a revoke, the key is refused for pairing everywhere (`claimsKey`). A browser that joins again
  after a revoke makes new keys (§7), so the burned key never comes back.

## 11. Migration of paired web devices

| today                                       | after the new build on the paired host                                                                                                                                        | person's action |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| a browser paired with one host, in a mesh   | its next session to that host runs the roster stream: admitted as a client member (§5), learns every machine (§6), dials them over the relay. Its `directUrl` is ignored (§8) | none            |
| a browser paired with one host, in no mesh  | the roster stream answers "this host is in no mesh"; the browser keeps that host as its one member, over the relay. It joins a mesh when one exists, with an invite           | none            |
| a browser paired with several hosts (#1331) | each paired host it reaches admits it once; the first admission makes it a member, the others are refreshes (§5.1)                                                            | none            |
| a paired browser whose host is older        | §5.4: works through that host as today                                                                                                                                        | update the host |
| a new browser                               | joins with an invite (§4). The web's `/pair` page leads to **Join a mesh**; a device-pairing link still pairs (legacy, §9)                                                    | —               |

Settings' **Pair a device** becomes **Add a browser or phone** (§4.2). The host's `doriface-host pair` stays, for older
web builds.

## 12. Threat model

| threat                                              | answer                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a leaked invite link or code                        | the offer is single-use and expires in 10 minutes; a client invite always asks (§4.3); the approver compares the join code (§9), and a different session has a different code (one try, 1 in 10^6)                                |
| the relay sits in the middle of a join              | a link pins the inviter's key and its secret is the psk; a code runs CPace. A relay without the secret cannot finish the handshake, and a different session shows a different join code                                           |
| the relay vouching instead of a comparison          | not used (§9): the relay holds no key that opens a session, so its word is not a trust root                                                                                                                                       |
| a member feeds the browser a forged roster          | every record passes `door` against the held set, and membership is `viewOf`. Only a member can admit, and the view's own rules hold                                                                                               |
| the admitting host is revoked, or leaves            | the admitter binding (§10.1) de-authorizes every client it admitted, on every member, at the write that revokes it                                                                                                                |
| a migrated device is unpaired on its admitting host | revoked mesh-wide once that host runs and reaches the others. Until then it reaches B: §10.5 states this, and `devices revoke` points to `mesh revoke` on a live member                                                           |
| unpair races an admit                               | the admit re-reads `devices.json` inside its `mesh.json` transaction, and the sweep runs after every admit                                                                                                                        |
| a revoked member hides its revoke from a browser    | union with history retention: a revoke the browser holds is never dropped. A browser that never learned the revoke dials the revoked member, which is the partition limit of §10.2                                                |
| the relay redirects a dial                          | each session is Noise IK, pinned to the member's Noise key from the verified view. The relay sees ciphertext only                                                                                                                 |
| the relay as the only path (§8)                     | the relay now sees which members a browser talks to, when, and how much, where a LAN session hid that before. The relay down means no web session at all. Both are the cost of #1381's order, stated here                         |
| script injection in the app's origin                | can use the keys while the page is open (owner-equivalent, revision 4 §4); cannot copy a non-extractable key out; can copy raw-byte keys (WebKit). Same as today's device key. Removal is §10.3                                   |
| storage cleared or evicted                          | the identity is gone, nothing is recoverable from the server side, and the old card is a member nobody can use until removed (§7)                                                                                                 |
| the browser poses as a machine                      | its card is `kind: "client"`. Its key is kept out of the Noise map, so it is refused on `"mesh"`, refused on `"roster"` as a machine, and the `core.id` rule is unchanged                                                         |
| the browser admits others, or votes                 | it signs nothing but its own card. A client is not a record author or witness (`packages/mesh/src/view`). It can ask its machine to open an invite, which that machine's owner-equivalent hc already allows                       |
| a `leave` names another client                      | refused: the host signs a leave only for the client that authenticated the roster session (§10.4)                                                                                                                                 |
| a card is replayed on another host or session       | the card is bound to that session's offer nonce and to its authenticated key                                                                                                                                                      |
| unbounded work from the stream                      | same parser bounds as a welcome (`MAX_RECORDS`, 2048-byte bodies, 4 MiB unread). An offer goes only to a paired device or a client member, and a browser refreshes at most once per session open, at most every 10 min per member |
| an old machine that cannot read a client admission  | `admissionRefusal` withholds the admit until every machine has shown it reads the format (revision 4 §7). Until then the joiner gets the refusal sentence                                                                         |
| browsers exhaust the plan                           | clients count against the admitting machine's `devices` limit, never `machines` (§5.2)                                                                                                                                            |

## 13. Compatibility

| case                                                                  | behaviour                                                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| browser already paired with one host (new build both sides)           | §11: admitted on its next session, learns the members, no re-pairing                                                                                                        |
| new browser, inviter host older than #956                             | the client card is refused (unknown kind); the join page says the host needs an update                                                                                      |
| new browser, a member older than this design                          | the roster stream is refused at the handshake; that member is still dialled over the relay and accepts the browser once its index holds the admit (#956 hosts read clients) |
| older web build, new host                                             | never opens the roster stream and still pairs with `doriface-host pair`. Nothing changes                                                                                    |
| a mesh with a machine that has not shown format support               | admission is refused with the readiness sentence; a paired device keeps working through its host                                                                            |
| a mesh at its plan's `machines` limit                                 | a browser is still admitted when the admitting machine has `devices` room; a machine join at limit-1 still succeeds after any number of client admissions                   |
| the admitting member stops right after the admit, before B synced it  | B refuses with 4401; for a view member that is "settling", and B is retried on the ladder until it accepts                                                                  |
| host in no mesh                                                       | an invite from it founds the mesh (as `mesh pair` does); a paired device keeps that host as its one member                                                                  |
| desktop app on its own host (loopback)                                | unchanged: loopback is the one non-relay path, local and token-authenticated (§8)                                                                                           |
| a saved direct (LAN) address                                          | ignored by the web: relay only (§8). The setting still parses, so a downgrade reads it                                                                                      |
| `doriface-host connect --mesh`, mesh lines, gossip                    | unchanged                                                                                                                                                                   |
| push                                                                  | a migrated device keeps its push association on its paired host (revision 4 §4). A joined browser registers push on the machine it chooses, over the relay                  |
| older pending-join reader (status document)                           | `code` is an extra field; `objectOf` reads only named fields, so an older web client shows the fingerprint row as today                                                     |
| CLI `mesh join <link>` on a machine                                   | the fingerprint question is gone for a link; the command shows the join code while it waits                                                                                 |
| B listed twice while A is up (A's hc lists B, and B is a view member) | as with two pairings today (#1331); showing machines per member from the client's own sessions is #1296                                                                     |

## 14. Rollout and tests

Three pull requests, one behaviour each. Each is `Part of #942` and `Part of #1381` except the last, which is
`Fixes #942` and `Fixes #1381`.

1. **Host: clients join and stay members** — the `"roster"` stream (hello union, authorization column, offer/card/admit/
   records exchange, `leave`); the admitter binding in `indexOf`; the client branch of `isRejoin` for both `serveJoin`
   and the roster stream; `machineCount` for `machines` and the admitter's `devices` count for clients; client invites
   always ask; the join code on the pending join, the status document and both CLI prompts; the revoke-on-unpair sweep.
   Unit tests on the real index and store:
   - a paired device is admitted as a client on `"roster"` and receives the records; a client member gets a refresh and
     nothing is signed;
   - a machine's Noise key, a machine's device key, a revoked key and an unknown key are refused on `"roster"`; a card
     bound to another nonce, another key or kind `"machine"` is refused; not format-ready means refused and not signed;
     in no mesh means refused and nothing founded; the old stream union still refuses `"roster"` (decode test);
   - a client card on an auto offer is asked, not admitted; the pending join carries the code both ends compute from
     the same handshake (one test drives both ends of a real `secureLink` pair);
   - admitter binding: after `mesh revoke` or `mesh leave` of A, a client A admitted is refused on B's hc stream and its
     open session there closes;
   - race: a device unpaired between the handshake and the admit is not admitted and nothing is signed; the sweep signs
     nothing when `devices.json` cannot be read; `devices revoke` of a client member prints the `mesh revoke` hint;
   - plan: with `machines` = N, client admissions at N-1 and N machines succeed and a machine join at N-1 still
     succeeds; a client over the admitter's `devices` limit is refused;
   - a concurrent second admission of the same device is a refresh, not `ANOTHER_KEY`;
   - `leave` revokes exactly the session's client; a `leave` with another client's card is refused.
2. **Web: the browser joins and learns the mesh** — card key custody; the join page and its states (§4.4); the join
   code; the bundle store and its checks; view members in `MeshConnections`; refresh; settling; removed and leave
   states; **Add a browser or phone**; migration of a paired device. Unit tests:
   - a welcome from the inviter teaches B, and B is dialled; a record that fails `door` is refused and nothing kept;
   - a refresh that omits a held revoke keeps it; a view that revokes the browser, or orphans it, drops the members;
   - an older host's refusal leaves the roster as it was; a view member's 4401 is "settling" and retried, a paired
     member's 4401 is still "Pair it again"; a paired member wins over a view member with the same hostId;
   - both keys are created once across two concurrent loads; a store that cannot keep a `CryptoKey` gets raw bytes;
   - an empty store after a clear shows **Join a mesh**, not a broken session.
3. **Web: relay only** — `connect()` without the direct path; the Relay label; the settings parser ignoring
   `directUrl`. Tests: no direct dial happens with a saved `directUrl` and LAN URLs offered; the e2e below.

**E2e (CI):** a desktop browser and a phone (mobile emulation) each join through an invite on the fake relay, with every
WebSocket that is not the relay refused by the page, and each opens a terminal. The fake relay holds one uplink (#1297),
so the "A stopped" half is measured on real hosts.

**Acceptance on two real machines:** A and B in one mesh; a desktop browser and a phone browser that each joined with an
invite from A; A's host stopped; both still list B and open a terminal on B.

## 15. Review findings and where they are answered

| finding (revision 1, FIX_FIRST)                            | answered in                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| HIGH: a client outlives its admitting host                 | §10.1 admitter binding; §5.3 the argument is enforced; tests           |
| MEDIUM: unpair is no longer immediate or partition-proof   | §10.5 "only as fast as the admitting host"; threat rows; CLI hint      |
| MEDIUM: the unpair/admit race                              | §5 re-read inside the transaction; §10.5 sweep after every admit; test |
| MEDIUM: auto-admission spends the `machines` limit         | §5.2; compatibility row; tests at N-1 and N                            |
| MEDIUM: a learned member's 4401 becomes "Pair it again"    | §6 settling; compatibility row; tests                                  |
| LOW: `isRejoin` has no client branch                       | §5.1, used by both `serveJoin` and `"roster"`                          |
| LOW: the sweep's behaviour on an unreadable `devices.json` | §10.5 signs nothing                                                    |
| LOW: unpair on a host that did not admit                   | §10.5                                                                  |
| LOW: precedence, key storage, B listed twice, burned key   | §6 precedence; §7 keys; compatibility row; §10.5 burned key            |
