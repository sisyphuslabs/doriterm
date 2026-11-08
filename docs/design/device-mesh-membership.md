# Devices and browsers are mesh members: membership, the web's join, relay-only transport

Status: revision 5 for the design gate, 2026-11-08. Issues #942 and #1381. Revision 5 folds revision 4's FIX_FIRST (§15):
the joining side confirms the join code too (§9). Revision 4 folded revision 3's FIX_FIRST and the relay transport rows
(§8). Revision 2 (device membership) was folded from revision 1's FIX_FIRST and was not
yet re-reviewed when the scope widened. Revision 3 kept revision 2's mechanism
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
| **a join link or code from any member** (new default) | the existing mesh join on a mesh offer, with a `kind: "client"` card | the join code, confirmed on both sides (§9)          |
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
unchanged except for the join code's commitment exchange and the joiner's confirmation (§9), the plan rule (§5.2) and
"client invites always ask" (§4.3). The browser runs **one** join session per invite: a session that breaks after the offer ends the attempt with
"Ask for a new invite", and the browser never runs it again on its own (§9 says why).

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
auto-admitted, as today. `PendingJoins` approves every join while `setAuto` is on
(`apps/host/src/mesh/pending-joins.ts`); it gains the card's kind, and auto approval applies to `kind: "machine"` only.

### 4.4 Join flow UX

| step | joining browser (phone or desktop)                                                                                                                                                                                                                                                                            | approving member (the inviter's CLI, or any web client connected to it)                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | opens the link (or scans the QR, or types the code on `/join`). Sees **Join this mesh**: the inviter's name, "This browser becomes a member and reaches every machine in the mesh". Name field prefilled from the device. One button: **Join**                                                                | nothing yet                                                                                                                                                                         |
| 2    | **Does _studio_ show this code?** The join code `482 913` in large digits: "Look at _studio_'s screen, or ask the person who sent the invite. If it shows no code or another one, the invite is not from your mesh." **The codes match** / **The codes differ**. Nothing is stored and nothing is dialled yet | a pending join appears: **Approve "Pixel 9" (browser)?** with the join code `482 913`: "Approve only if the joining screen shows the same code". **Approve** / **The codes differ** |
| 2b   | after **The codes match**: **Waiting for approval on _studio_**, the code still shown                                                                                                                                                                                                                         | after **Approve**, until the joiner confirms: "Waiting for _Pixel 9_ to confirm the code"                                                                                           |
| 3a   | both confirmed: **Joined.** The machine list opens and fills in as each member answers                                                                                                                                                                                                                        | "Pixel 9 joined the mesh"                                                                                                                                                           |
| 3b   | denied: **Not joined: _studio_ denied this browser.** "Ask for a new invite." The link is spent                                                                                                                                                                                                               | "Denied. The invite is spent; open a new one"                                                                                                                                       |
| 3c   | the offer expired, was used, or the inviter is unreachable: the existing sentences (`handshake.ts` `REASONS`), with "mesh pair" in place of "pair"                                                                                                                                                            | nothing                                                                                                                                                                             |
| 3d   | **The codes differ**: **Not joined.** "This invite may not come from your mesh. Ask for a new one from a machine you can see." Nothing was stored                                                                                                                                                             | "The joining screen showed a different code. The invite is spent; open a new one"                                                                                                   |

The browser shows no long fingerprint in this flow. The join code, confirmed on **both** screens, replaces it (§9). The
join is complete only when the approver approved **and** the joining person confirmed; either one alone admits nothing.

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

| who the session key is                                    | the host                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a current **client member** whose card has this `signPub` | sends the records (a refresh), and admits nothing. A `leave` signs the revoke of exactly this client (§10.4)                                                                                                                                                                                                                                                                             |
| a **paired device** of this host that is no member        | admits the card (unless §5.1's one-admit rule refuses it), then sends the records. In order: `admissionRefusal` (format readiness); the client branch of the rejoin and collision checks (below); then, **inside the admit's `mesh.json` transaction**, a re-read of this host's `devices.json` confirming the key is still paired; then it signs an `admit` exactly as `serveJoin` does |
| a machine member's Noise or device key                    | refused at the handshake: a machine syncs on `"mesh"`                                                                                                                                                                                                                                                                                                                                    |
| a revoked or superseded key, or an unknown one            | refused at the handshake (4401)                                                                                                                                                                                                                                                                                                                                                          |
| any key, while this host is in no mesh                    | `refused "this host is in no mesh"`: no mesh is founded for a paired device (a browser's join on an invite founds one, as `mesh pair` does today)                                                                                                                                                                                                                                        |

### 5.1 The rejoin check for a client

`isRejoin` finds the holder with `index.member()`, which never answers for a client. The client branch uses
`index.client(card.devicePub)` instead:

- If the same `signPub` already holds that key, this is a refresh. This also covers two concurrent admissions of one
  device: the second becomes a refresh.
- If another signing key holds it, the card is refused (`KEY_HELD`).
- If the `signPub` is a member with another key, the card is refused (`ANOTHER_KEY`).
- `namedByAnother` applies unchanged.
- **One admit per client signing key, ever.** A host never signs an admit for a `signPub` that the held records
  already admit. If that admit is current, the session is a refresh. If the client is revoked, or **orphaned** (its
  governing admit's signer is no longer a current machine member, §10.1), the card is refused with
  `refused "this browser was removed from the mesh: join again with an invite"` and nothing is signed. `indexOf` drops
  an orphan, so this check reads the records' admits for the `signPub`, not `index.client()`. The way back is a new
  join with new keys (§7).

`serveJoin` (§4) uses the same client branch. A browser whose welcome was lost after approval does not run the join
again (one session per invite, §4.1). Its next roster session to the inviter is a refresh, and that hands it the records.

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
  themselves. **Join again** makes new keys (§7): no host admits the old `signPub` again (§5.1).

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
- **Removed or orphaned.** **Join again** deletes both keys and the bundle, and makes new ones before the join. A
  migrated device's paired entry on its host keeps the old device key. That entry stops mattering once the new identity
  is a member, and `devices revoke` removes it.
- **Non-extractable is not "safe from the page".** A script running in the app's origin can use the key while the page
  is open. It cannot copy it out where WebCrypto holds it. Raw-byte storage (WebKit) can be copied by such a script. §12
  states this.

## 8. Relay-only transport

Every connection a browser makes to a member is a relay session: `connectRelayClient` to the member's hostId, then
Noise IK pinned to the member's key from the view. Today `connect()` tries a saved direct address first and falls back to
the relay only when direct misses its 300 ms budget (`apps/web/src/connection/connect.ts`, `openDirect`,
`DIRECT_BUDGET_MS`).

| case                                              | behaviour                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a browser (web surface), any member               | **no direct path at all** (#1381). The web's `ConnectionPath` set is `relay`, plus `loopback` for a page served by a host on the same computer (local development). `openDirect` and its race, the saved `directUrl` and the LAN URLs a host sends are not used                                                    |
| any client, a member learned from the view (§6)   | relay only **by construction**: a learned `MemberTarget` carries no `directUrl` (§6), so the direct race is never entered. This holds on the desktop shell too                                                                                                                                                     |
| the desktop shell, a host it paired with directly | keeps `direct` then `relay` (#446), and `loopback` to the host on the same computer. The shell is not the web surface #1381 orders onto the relay; a paired host on the same LAN is a different trust position from a learned member reached across the internet                                                   |
| every mesh read                                   | the mesh document and the machine list ride the ordinary session (`apps/web/src/mesh/mesh-reader.ts`: `doc.get`, `doc.set`, `machine.list`), so they follow the rows above. There is no separate mesh transport                                                                                                    |
| the join (§4), the roster stream (§5), push       | over the relay, from every client                                                                                                                                                                                                                                                                                  |
| a member's relay session drops                    | that member's own store reconnects on its own retry ladder (`MeshConnections`: one connection and one ladder per member, #994). Other members' sessions are untouched                                                                                                                                              |
| a client with N members                           | one relay session per member, each counted against **that member's** limits (`MAX_ACTIVE_SESSIONS` 32 and `MAX_PENDING_SESSIONS` 8 per host, `packages/relay-client/src/wire/limits.ts`). The relay has no per-client limit, so N members cost N sessions over N hosts, and cold start dials them in parallel (§6) |
| a member's uplink is down                         | the relay closes that dial with 4404 (host offline). Only that member's store backs off (`backoffDelay`, at most 30 s) and shows the member offline                                                                                                                                                                |
| what it costs                                     | the browser loses the local-network win of the 300 ms direct race and puts the relay round trip in front of every call. The desktop shell keeps its fast local path to its paired host                                                                                                                             |

- **Which surface, today and after PR 3.** Today a plain browser **does** take a direct path: `directDial` dials `wss://`
  and loopback addresses from any page, and plain `ws://` from a page that is not a secure context
  (`apps/web/src/connection/direct-address.ts:63-67`), and `connect()` races that dial against the relay. PR 3 (§14)
  adds a gate at the top of `openDirect` (`apps/web/src/connection/connect.ts`): unless the desktop shell's forwarder is
  present (`canForwardPlainWs()`, `apps/web/src/connection/direct-forward.ts`), it returns without dialling, so
  `connect()` goes to the relay. The loopback path of a page served by a host on the same computer is a separate path
  (above) and is unchanged. Saved settings keep parsing a `directUrl` (downgrade) and a browser ignores it.
- **Loopback** is a local socket authenticated by a token, not a network path, and it carries no device key (revision 4
  §4).
- The status bar's path label says **Relay** on every browser session. The Direct label and its reasons (#446) remain
  only in the desktop shell.
- **Proof** (§14): an e2e in which the page refuses every WebSocket that is not the relay's origin, so every direct dial
  fails, and the browser still joins, renders the mesh status and drives a session to a learned member end to end. It
  is the blocking proof for the web surface: without it "learned members go through the relay" describes the code and
  is not a measured fact.

## 9. Comparing keys at a join

Today a mesh join asks a person to compare two 40-character fingerprints. The CLI `mesh join <link>` asks "join the mesh
of host H, fingerprint XXXX XXXX …?"; `mesh pair` asks "admit N H fingerprint XXXX XXXX …?"; the web's pending-join row
shows the joiner's fingerprint. People do not compare ten groups of hex reliably. This section replaces both questions
with one 6-digit code that **both** people confirm, each against the other side's screen.

**The rule:** a comparison step names the trust problem it solves, or it is not in the flow.

| comparison                                | the problem it would solve                                                | decision                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| joiner checks the inviter's key (link)    | a link from someone else's host, or a link substituted in transit         | **replaced by the joiner's confirmation of the join code**: a substituted link puts the joiner in a session with the substituter. The real inviter shows no code for it, or an independent one (below), so the joining person answers **The codes differ** |
| joiner checks the inviter's key (code)    | the relay answering the slot lookup with another host that knows the code | **replaced by the joiner's confirmation of the join code**: CPace proves only that the other end knows the code, and a leaked code is known to the attacker too. The confirmed join code is what catches this                                              |
| approver checks the joiner                | a leaked invite used by someone else                                      | **kept, as a 6-digit join code** that the approver confirms                                                                                                                                                                                                |
| relay or account "vouches" for the joiner | —                                                                         | **not used**: the relay is outside the trust boundary (it holds no key that opens a session), so it cannot vouch                                                                                                                                           |

**The join code** is a short authentication string with a commitment, the construction of Bluetooth's numeric
comparison: the side that answers last commits to its contribution before it sees the other's. Without the commitment,
the inviter's message 2 is the last input to the handshake hash. An attacker in the inviter's seat could then vary it
until the victim's code equals the code the real inviter shows for the attacker's own join, about 10^6 cheap tries. The
exchange runs on the join session, right after the handshake:

```
host   -> offer   { mesh, inviter, nonce, commit: SHA-256("doriface/1.3 join commit" || h || Ni) }
device -> card    as §4.1, and beside it sas: Nj            (Nj: 32 fresh random bytes)
host   -> reveal  { Ni }                                    (Ni: 32 fresh random bytes, drawn before the offer is sent)
device    closes the session unless SHA-256("doriface/1.3 join commit" || h || Ni) == commit
both      code = uint32_be(HKDF-SHA256(ikm = h || Ni || Nj, salt = "", info = "doriface/1.3 mesh join code", 4)) mod 1_000_000
          shown as "482 913"
device -> confirm { }                                       (only after the joining person chose "The codes match")
          or abort { }                                      ("The codes differ": the device closes the session)
host      signs the admit only when it holds both the approver's Approve and the device's confirm
host   -> records ..., done                                 (the welcome, as today)
```

The two confirmations are independent and may come in either order. The host waits for both while the offer's 10
minutes last; an `abort`, a **The codes differ** on the approver, a dropped session or the expiry withdraws the pending
join, and the offer stays spent. The joiner stores nothing and dials no member before its person confirms: a welcome can
only arrive after `confirm`, and the joiner refuses one that arrives earlier.

`h` is the session's Noise handshake hash (`SecureLink.handshakeHash`). It binds both static keys, both ephemerals and
the pairing psk.

- **An attacker as the inviter** (a substituted link, or the relay sending the victim's slot to a host that knows a
  leaked code). The attacker is also the approver of the victim's join, so its own Approve proves nothing; what stops it
  is the **joiner's** confirmation. The joining person compares the code with the real inviter's screen. That screen
  shows no pending join at all, or, if the attacker also joined the real offer as itself, the code of the attacker's
  own session. The attacker commits to `Ni` before it sees `Nj`, and `Nj` is fresh and uniform, so the victim's code is
  uniform whatever the attacker sends: it equals the real inviter's code with probability 10^-6. Otherwise the person
  answers **The codes differ**, the browser stores nothing and the machine CLI exits "not joined".
- **An attacker as the joiner** on the real offer picks `Nj` without knowing `Ni`, which the commitment hides. The
  approver's code is uniform whatever the attacker sends, so the real approver's confirmation catches it.
- **Both at once** (a leaked code and a malicious relay): the attacker wins only if a human confirms on each screen a
  code that the other real screen shows. The two codes are independent and uniform, so they match with probability
  10^-6. **The offer is spent by the first card it receives**, whatever happens after: a session that drops before both
  decisions withdraws its pending join and does not reopen the offer. The joiner runs one session per invite (§4.1). So
  an invite gives an attacker one try at 1 in 10^6, and a denial or a mismatch on either side spends it.
- This is Bluetooth numeric comparison as specified: **both** devices require their person's confirmation.
- The wire gains `commit`, `sas`, `reveal`, `confirm` and `abort`, nothing else. The host adds `code` and
  `joinerConfirmed` to the pending join (`PendingJoin`, the mesh status document's pending entry, the `mesh-pending`
  control answer); the browser computes its own code.
- **Which offers carry it.** Every offer that asks: always for a browser (§4.3), and a machine's join on an offer that
  is not auto. A browser refuses an offer without `commit` ("this machine needs an update"). An auto offer (#668,
  machines only) carries none. There the joining machine keeps today's fingerprint question (`confirmFingerprint`,
  `apps/host/src/mesh/join-dial.ts`), because nobody compares a code on an auto offer. A machine that gets an offer
  without `commit` asks the fingerprint question, so stripping the commitment gains an attacker nothing.
- **The machine CLI on an offer that asks.** `mesh join` replaces today's fingerprint question (link) and the required
  `--fingerprint` (code) with a required code question: `does <host> show code 482 913? [y/N]`. `--yes` does not
  answer it; a scripted machine join uses an auto offer (#668), which keeps today's fingerprint rules. A `--fingerprint`
  given on an offer that asks is still checked against the inviter's key, as an extra pin. Only `y` sends `confirm`;
  anything else sends `abort` and exits "not joined". So the joining machine keeps a human check on every offer that
  asks, with 6 digits instead of 40 hex characters.

**What each side verifies:**

| side                                   | the software checks                                                                                                                                                                                                                                       | the person confirms                                                                   | without it                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| joiner (browser, or machine CLI)       | the session's static key is the link's inviter key (link), or the other end knows the code (CPace); `reveal` opens `commit`; the welcome passes §4.1's checks (the inviter is a machine member with the key it dialled, the joiner is the client it sent) | the real inviter's screen shows this code: **The codes match**, which sends `confirm` | no `confirm` is sent, nothing is stored, no member is dialled |
| approver (inviter's CLI or web client) | the card's signature, kind and offer binding (`verifyCard`); the plan and format rules; one card per offer                                                                                                                                                | the joining screen shows this code: **Approve**                                       | no admit is signed                                            |
| inviter host                           | holds both decisions before it signs the admit; spends the offer on the first card                                                                                                                                                                        | —                                                                                     | —                                                             |

**What each side shows, and when:**

| surface                                          | when                                    | shows                                                                                                                                                              | mismatch                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| joining browser                                  | from the reveal until both decisions    | "Does _studio_ show this code?" and the code `482 913`, large, tabular digits, **The codes match** / **The codes differ**; then "Waiting for approval on _studio_" | **The codes differ** sends `abort`: "Not joined. This invite may not come from your mesh." Nothing is stored. The approver's denial: "Not joined: _studio_ denied this browser. Ask for a new invite." |
| approving web client (any client of the inviter) | while the join is pending               | name, kind (browser or machine), the code `482 913`, **Approve** / **The codes differ**. The joiner's long fingerprint stays under "Details"                       | **The codes differ** denies, spends the offer, and the row reads "Denied: the codes differed. Open a new invite."                                                                                      |
| `doriface-host mesh pair` (CLI)                  | when the join arrives                   | `admit "Pixel 9" (browser) code 482 913? Approve only if the joining screen shows the same code [y/N]`                                                             | `N` denies, as today                                                                                                                                                                                   |
| `doriface-host mesh join` (machine CLI)          | after the reveal, on an offer that asks | `does <host> show code 482 913? [y/N]`, then `waiting for approval on <host>`. The fingerprint question is asked only on an offer without `commit`                 | `N` sends `abort` and exits "not joined"; the inviter's denial prints the refusal, as today                                                                                                            |
| a member's list, after the join                  | any time                                | each member's long fingerprint, as today (`mesh-rows.tsx`), for audit                                                                                              | —                                                                                                                                                                                                      |

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

An orphan has no way back with the same keys. §5.1 refuses to admit its `signPub` again, so no host re-signs an admit
for it on every refresh, which would fill the record log (`door`'s "mesh log full"). It joins again with new keys (§7).

**The binding covers every client the machine admitted**, including browsers a person approved through its invites.
Records do not say how a client was admitted, and the binding must be derived the same way on every host, so it is not
scoped to roster admissions. The cost is that retiring a machine also removes the browsers it invited, so the commands
that retire one say so before they act:

- `doriface-host mesh revoke <machine>` and `doriface-host mesh leave` list the client members whose governing admit
  that machine signed (`these browsers and phones leave the mesh with <machine>: Pixel 9, office laptop`) and ask
  `[y/N]`. `--yes` skips only the question; the list is still printed.
- The web's machine row **Remove** shows the same list in its confirmation.
- Each removed browser shows "This browser was removed from the mesh" with **Join again** (§6), and joins through any
  other member's invite with new keys.

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
   for every client member that is in its roster-admit marker (below), whose governing admit is its own, and whose
   `devicePub` is no longer paired.
3. Once at start, which covers a revoke made while the host was down.

**The roster-admit marker.** No record says how a client was admitted, so the host keeps a local file,
`roster-admits.json` in its state dir (0600, under the state lock, like `devices.json`). It holds one entry
`{ admitId, signPub, devicePub }` per client this host admitted on the roster stream, where `admitId` is the id of the
signed `admit` record (known before the commit). The entry is written inside the admit's transaction (§5), under the
same lock and before the `mesh.json` commit: the marker first (temporary file and rename), then the admit. A transaction
that aborts without crashing (a failed `mesh.json` write, a refusal after the marker was written) removes its entry
before it releases the lock. A crash between the two leaves an entry whose admit was never stored; the sweep ignores it
and prunes it. The sweep revokes only a client whose **governing admit's id** is an entry's `admitId`, whose governing
admit is this host's, and whose `devicePub` is not in `devices.json`. So a stale entry can never match a later admit of
the same keys, which has another id. A browser that joined on an invite (§4) is never in the marker, so the sweep never revokes it, at start or
later.

The sweep also runs after every admit. When `devices.json` or the marker cannot be read or does not parse, the sweep
**signs nothing** and logs why: a revoke burns the key mesh-wide, and an unreadable file says nothing about what was
removed. A lost marker can only leave an unpaired device a member until `mesh revoke`. It can never burn a key.

- **Unpair is only as fast as the admitting host.** If A is stopped or partitioned, an unpair on A signs nothing until A
  runs and reaches the others. Until then B keeps accepting the device. `devices revoke` of a device that is a client
  member says so: the membership ends when this host is running and reachable, and
  `doriface-host mesh revoke <name>` on any running member ends it now. It prints that line whether the host is running
  or not.
- **Unpair on a host that did not admit the device** removes only that host's paired entry. The device stays a client
  member and that host keeps accepting it as one; `devices revoke` there prints the same `mesh revoke` hint.
- **A burned key.** After a revoke, the key is refused for pairing everywhere (`claimsKey`). A browser that joins again
  after a revoke makes new keys (§7), so the burned key never comes back.

### 10.6 Push for a client member

Today the push stream admits only a paired device (`sessionPeer`, `apps/host/src/e2ee/authorize.ts`), so a browser that
joined on an invite would get no push.

- **Authorization.** The push stream admits a current **client member** as well as a paired device, on any machine
  member. A machine member is still refused. This is one change in `sessionPeer`'s `"push"` branch: a `client` peer is
  accepted.
- **Association.** The subscription goes in that machine's `push-subscriptions.json` with `owner` set to the client's
  device key (base64url). That is the owner key a paired device already uses, so a migrated device's subscriptions keep
  working unchanged. A browser registers on the machines it chooses: Settings > Notifications lists them, and the
  default is every machine it holds a session with.
- **Cleanup.** `prune()` keeps the owners that are paired devices **or current client members** of the index. It runs at
  every index rebuild (a `mesh.json` write: a revoke, a leave, or an admitter's revoke that orphans clients) as well as
  on today's `devices-changed`. A revoked, departed or orphaned client loses its push on each machine as the revoke
  reaches it, and `closeRevoked` closes its open push stream.
- The per-owner cap (`MAX_PER_OWNER`) applies to a client unchanged.

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

| threat                                              | answer                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a leaked invite link or code                        | the offer expires in 10 minutes and is spent by the first card; a client invite always asks (§4.3). The approver confirms that the joining screen shows its code, so a stranger using the leaked invite is denied. The commitment makes each side's code uniform whatever an attacker sends (one try per invite, 1 in 10^6)                                                      |
| the relay sits in the middle of a join              | a relay without the link secret or the code cannot finish the handshake (a link pins the inviter's key). A relay that also holds a leaked code, or sends the slot to a host that does, sits in the inviter's seat and approves its own pending join; the **joiner's** confirmation against the real inviter's screen catches it (§9, one try at 1 in 10^6)                       |
| a substituted invite link                           | the joiner's session is with the substituter, which approves its own pending join. The joining person must confirm that the real inviter's screen shows the same code; that screen shows none, or an independent one (§9), so the person answers **The codes differ** and nothing is stored. The machine CLI's code question has no `--yes` bypass                               |
| the joining side skips the comparison               | it cannot finish: the joiner sends `confirm` only from its person's **The codes match**, the host signs no admit without it, and a joiner refuses a welcome that arrives before its own `confirm` (§9)                                                                                                                                                                           |
| legacy device pairing in a mesh (residual)          | `doriface-host pair` has no approver step, and §5.3 turns a paired device into a member without asking. A leaked device-pairing link is therefore owner-equivalent mesh-wide, as it is today through the paired host's hc. Stated here; an ask step for device pairing in a mesh is a follow-up                                                                                  |
| the relay vouching instead of a comparison          | not used (§9): the relay holds no key that opens a session, so its word is not a trust root                                                                                                                                                                                                                                                                                      |
| a member feeds the browser a forged roster          | every record passes `door` against the held set, and membership is `viewOf`. Only a member can admit, and the view's own rules hold                                                                                                                                                                                                                                              |
| the admitting host is revoked, or leaves            | the admitter binding (§10.1) de-authorizes every client it admitted, on every member, at the write that revokes it. This includes browsers a person approved through that host's invites; `mesh revoke` and `mesh leave` list them and ask first (§10.1)                                                                                                                         |
| a migrated device is unpaired on its admitting host | revoked mesh-wide once that host runs and reaches the others. Until then it reaches B: §10.5 states this, and `devices revoke` points to `mesh revoke` on a live member                                                                                                                                                                                                          |
| unpair races an admit                               | the admit re-reads `devices.json` inside its `mesh.json` transaction, and the sweep runs after every admit                                                                                                                                                                                                                                                                       |
| a revoked member hides its revoke from a browser    | union with history retention: a revoke the browser holds is never dropped. A browser that never learned the revoke dials the revoked member, which is the partition limit of §10.2                                                                                                                                                                                               |
| the relay redirects a dial                          | each session is Noise IK, pinned to the member's Noise key from the verified view. The relay sees ciphertext only                                                                                                                                                                                                                                                                |
| the relay carries a learned member's session        | a learned member was never paired with this browser, but its session is Noise IK pinned to its Noise key from the verified view, exactly as a paired session is pinned. The relay sees nothing and cannot substitute itself                                                                                                                                                      |
| the relay as the only path (§8)                     | the relay now sees which members a browser talks to, when, and how much, where a LAN session hid that before. The relay down means no web session at all. Both are the cost of #1381's order, stated here                                                                                                                                                                        |
| script injection in the app's origin                | can use the keys while the page is open (owner-equivalent, revision 4 §4); cannot copy a non-extractable key out; can copy raw-byte keys (WebKit). Same as today's device key. Removal is §10.3                                                                                                                                                                                  |
| storage cleared or evicted                          | the identity is gone, nothing is recoverable from the server side, and the old card is a member nobody can use until removed (§7)                                                                                                                                                                                                                                                |
| the browser poses as a machine                      | its card is `kind: "client"`. Its key is kept out of the Noise map, so it is refused on `"mesh"`, refused on `"roster"` as a machine, and the `core.id` rule is unchanged                                                                                                                                                                                                        |
| the browser admits others, or votes                 | it signs nothing but its own card. A client is not a record author or witness (`packages/mesh/src/view`). It can ask its machine to open an invite, which that machine's owner-equivalent hc already allows                                                                                                                                                                      |
| a `leave` names another client                      | refused: the host signs a leave only for the client that authenticated the roster session (§10.4)                                                                                                                                                                                                                                                                                |
| a card is replayed on another host or session       | the card is bound to that session's offer nonce and to its authenticated key                                                                                                                                                                                                                                                                                                     |
| unbounded work from the stream                      | same parser bounds as a welcome (`MAX_RECORDS`, 2048-byte bodies, 4 MiB unread). An offer goes only to a paired device or a client member, and a browser refreshes at most once per session open, at most every 10 min per member. A refresh resends the whole record set (up to about 8 MiB per member per refresh at the record cap); a have-set or heads delta is a follow-up |
| a re-admit loop for an orphaned client              | §5.1: one admit per client `signPub`, ever. An orphan is refused and nothing is signed, so refreshes cannot fill the record log                                                                                                                                                                                                                                                  |
| an old machine that cannot read a client admission  | `admissionRefusal` withholds the admit until every machine has shown it reads the format (revision 4 §7). Until then the joiner gets the refusal sentence                                                                                                                                                                                                                        |
| browsers exhaust the plan                           | clients count against the admitting machine's `devices` limit, never `machines` (§5.2)                                                                                                                                                                                                                                                                                           |

## 13. Compatibility

| case                                                                  | behaviour                                                                                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| browser already paired with one host (new build both sides)           | §11: admitted on its next session, learns the members, no re-pairing                                                                                                                    |
| new browser, inviter host older than #956                             | the client card is refused (unknown kind); the join page says the host needs an update                                                                                                  |
| new browser, a member older than this design                          | the roster stream is refused at the handshake; that member is still dialled over the relay and accepts the browser once its index holds the admit (#956 hosts read clients)             |
| older web build, new host                                             | never opens the roster stream and still pairs with `doriface-host pair`. Nothing changes                                                                                                |
| older web build, new host, learned members exist in the mesh          | the old client never learns them and keeps working through its paired host. The roster stream is not a prerequisite for the mesh working                                                |
| desktop shell, a host it paired with on the same LAN                  | direct then relay, as today (§8); its learned members are relay only                                                                                                                    |
| a mesh with a machine that has not shown format support               | admission is refused with the readiness sentence; a paired device keeps working through its host                                                                                        |
| a mesh at its plan's `machines` limit                                 | a browser is still admitted when the admitting machine has `devices` room; a machine join at limit-1 still succeeds after any number of client admissions                               |
| the admitting member stops right after the admit, before B synced it  | B refuses with 4401; for a view member that is "settling", and B is retried on the ladder until it accepts                                                                              |
| host in no mesh                                                       | an invite from it founds the mesh (as `mesh pair` does); a paired device keeps that host as its one member                                                                              |
| desktop app on its own host (loopback)                                | unchanged: loopback is the one non-relay path, local and token-authenticated (§8)                                                                                                       |
| a saved direct (LAN) address                                          | ignored by the web: relay only (§8). The setting still parses, so a downgrade reads it                                                                                                  |
| `doriface-host connect --mesh`, mesh lines, gossip                    | unchanged                                                                                                                                                                               |
| push                                                                  | a migrated device keeps its push subscriptions on its paired host (owner = its device key, unchanged). A joined browser registers on the machines it chooses as a client member (§10.6) |
| older pending-join reader (status document)                           | `code` is an extra field; `objectOf` reads only named fields, so an older web client shows the fingerprint row as today                                                                 |
| CLI `mesh join <link or code>` on a machine, offer that asks          | the fingerprint question (link) and the required `--fingerprint` (code) become the required code question `does <host> show code 482 913? [y/N]`, with no `--yes` bypass (§9)           |
| CLI `mesh join` on an auto offer (#668)                               | unchanged: the fingerprint question for a link, `--fingerprint` for a code, `--yes` as today                                                                                            |
| replacing or retiring a machine that invited browsers                 | `mesh revoke <it>` / `mesh leave` names the browsers and phones it admitted, which leave the mesh with it (§10.1); each joins again through another member's invite                     |
| B listed twice while A is up (A's hc lists B, and B is a view member) | as with two pairings today (#1331); showing machines per member from the client's own sessions is #1296                                                                                 |

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
   - both confirmations: after Approve and no `confirm`, nothing is signed and the pending join reads "waiting for the
     joiner"; `confirm` and then Approve, in either order, admits once; an `abort` withdraws the pending join, signs
     nothing and leaves the offer spent; a joiner that receives a welcome before it sent `confirm` refuses it;
   - substituted inviter: a joiner dialled to an inviter that approves its own pending join does not store a bundle
     until its person confirms, and **The codes differ** stores nothing; `mesh join` on an offer that asks exits "not
     joined" on `N`, and `--yes` does not answer the code question; a `--fingerprint` that does not match still refuses;
   - commitment: a `reveal` that does not match `commit` is refused by the joiner; an inviter whose `Ni` changes after
     the commit is caught; the offer is spent by the first card, and a session dropped before the decision does not
     reopen it; a machine joiner asks the fingerprint question on an offer without `commit`;
   - marker: an invite-joined client survives the sweep at start and on `devices-changed`; an unpaired roster-admitted
     device is revoked; a missing or unparsable marker signs nothing; an admit transaction that aborts (a failed
     `mesh.json` write) leaves no marker entry, and a stale entry whose `admitId` is not the client's governing admit
     never matches a later invite admit of the same keys;
   - orphan: after A's revoke, a device also paired with B is refused on B's roster stream, and the record count does
     not grow over repeated refreshes; the same browser with new keys is admitted;
   - push: a client member opens the push stream on a machine and registers; a revoked or orphaned client's
     subscriptions are pruned at the index rebuild; a machine member is still refused;
   - admitter binding: after `mesh revoke` or `mesh leave` of A, a client A admitted is refused on B's hc stream and its
     open session there closes; `mesh revoke A` and `mesh leave` on A list every client A admitted (roster and invite)
     before asking, and `--yes` skips only the question;
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
   - an empty store after a clear shows **Join a mesh**, not a broken session;
   - an offer without `commit` is refused; a join session that breaks after the offer is not run again; **Join again**
     makes new keys;
   - the join page sends `confirm` only from **The codes match**, shows "Waiting for approval" after it, and on **The
     codes differ** sends `abort`, stores nothing and dials nobody.
3. **Web: relay only** — a new gate in `openDirect`: on the web surface it returns without dialling, so `connect()` goes
   to the relay; the Relay label; the settings parser ignoring `directUrl` in a browser. Tests: in a browser no direct dial happens with a saved `directUrl` and LAN URLs offered;
   with the shell's forwarder present a paired host still races direct; a learned member is never dialled direct on
   either surface; the e2e below.

**E2e (CI):** a desktop browser and a phone (mobile emulation) each join through an invite on the fake relay, with every
WebSocket that is not the relay refused by the page, and each renders the mesh status and opens a terminal on a member
it learned from the view. The fake relay holds one uplink (#1297),
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

| finding (revision 3, FIX_FIRST)                                          | answered in                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| HIGH: a leaked code plus the inviter's seat lets the join code be ground | §9 commitment before reveal; offer spent by the first card; one session per invite; threat rows; tests |
| MEDIUM: the sweep cannot tell a roster admission from an invite join     | §10.5 roster-admit marker, written in the admit transaction; tests                                     |
| MEDIUM: an orphaned client is re-admitted on every refresh               | §5.1 one admit per `signPub`; §10.1; §7 new keys; tests                                                |
| MEDIUM: a joined browser has no push                                     | §10.6; compatibility row; tests                                                                        |
| LOW: relay rows left to another lane                                     | §8 rows: per-member sessions and limits, 4404 and backoff                                              |
| LOW: legacy device pairing has no ask step                               | §12 residual row; follow-up                                                                            |
| LOW: a refresh resends the whole record set                              | §12 row; follow-up                                                                                     |

| finding (revision 4, FIX_FIRST)                                                             | answered in                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH: the join code gates only the approver; a substituted link or a man-in-the-middle wins | §9 `confirm`/`abort`: the joiner's person confirms against the real inviter's screen, the host signs only with both; §9 "What each side verifies"; §4.4 step 2, 2b, 3d; machine CLI code question without `--yes`; §12 rows; §13 rows; tests |
| LOW: the admitter binding also evicts invite-approved browsers                              | §10.1: kept uniform (records do not say how a client was admitted), and `mesh revoke`/`mesh leave` list the browsers that leave with the machine and ask; §12, §13 rows; test                                                                |
| LOW: an aborted admit transaction leaves a marker entry that a later invite admit matches   | §10.5: the entry carries the admit record's id, an abort removes it, and the sweep matches only the client's governing admit; test                                                                                                           |
| LOW: §8 says a plain browser already goes straight to the relay                             | §8 "Which surface": today's direct dial from a plain page is stated, and the relay-only rule is the new gate in `openDirect` (PR 3)                                                                                                          |
