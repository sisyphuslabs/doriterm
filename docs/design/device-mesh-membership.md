# A paired device becomes a client member, and learns the mesh

Status: revision 2 for the design gate, 2026-11-08. Issue #942. Revision 1's security review asked for fixes (FIX_FIRST: one HIGH, four MEDIUMs). §8 lists each finding and the section that now answers it. This builds on [client-mesh-member.md](client-mesh-member.md)
(revision 4, approved): it implements that design's stage 3 for the device that already exists, the one that paired with
a host. It adds no new trust root, no new record type and no new card field.

## 1. The gap, measured

Measured on dev `a4a83d5c` with two real machines (#942, 2026-11-08). A and B are in one mesh, and a browser device is
paired with A only. Stopping A's host leaves B up, but the device shows B as "unknown". It cannot open a terminal there,
and every socket it opened went to A.

Two things are missing, and both are in the client:

1. **Nothing makes the device a member.** Since #956 the hosts accept a `client` member on the hc stream
   (`apps/host/src/e2ee/authorize.ts`, `AuthorizeIndex.client`), but no flow creates one. `doriface-host pair` stores
   the device in A's `devices.json` and nowhere else, so B has never heard of the device's key.
2. **Nothing tells the device who the members are.** `MeshConnections.pair()` adds the paired host to the roster
   (#1331), and nothing adds the others (`apps/web/src/connection/mesh-connections.ts`).

## 2. The mechanism: one new stream, `"roster"`

A session (kind `0x01`) whose hello says `"stream":"roster"`. It is the device's one conversation about membership, and
it uses the mesh line codec and its bounds unchanged (`apps/host/src/mesh/lines.ts`, `line-parse.ts`):

```
host   -> offer   { mesh, inviter: <this host's signPub>, nonce }
device -> card    v2, kind "client", signed by the device's own Ed25519 key
host   -> records ... (the host's whole stored record set, batched as in a welcome)
host   -> done    { mesh }
host closes the session
```

The card is the one revision 4 §6 specifies:

- `signPub` is the device's own Ed25519 key, and `hostId = hostIdOf(signPub)`.
- `noisePub = devicePub =` the X25519 static key **this session authenticated**.
- `mesh`, `inviter` and `nonce` are copied from this session's offer.
- `name` passes `checkName`, `hcId` is `""`, and `kind` is `"client"`.

The host verifies the card (`verifyCard`) and the offer binding, and requires `kind === "client"` and
`noisePub === devicePub === remoteStatic`. Then:

| who the session key is                                    | the host                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a current **client member** whose card has this `signPub` | sends the records (a refresh), and admits nothing                                                                                                                                                                                                                                                                                              |
| a **paired device** of this host that is no member        | admits the card, then sends the records. In order: `admissionRefusal` (format readiness); the client branch of the rejoin and collision checks (below); then, **inside the admit's `mesh.json` transaction**, a re-read of this host's `devices.json` confirming the key is still paired; then it signs an `admit` exactly as `serveJoin` does |
| a machine member's Noise or device key                    | refused at the handshake: a machine syncs on `"mesh"`                                                                                                                                                                                                                                                                                          |
| a revoked or superseded key, or an unknown one            | refused at the handshake (4401)                                                                                                                                                                                                                                                                                                                |
| any key, while this host is in no mesh                    | `refused "this host is in no mesh"`: no mesh is founded for a device                                                                                                                                                                                                                                                                           |

**The rejoin check for a client.** `isRejoin` finds the holder with `index.member()`, which never answers for a client. The client branch uses `index.client(card.devicePub)` instead:

- If the same `signPub` already holds that key, this is a refresh. This also covers two concurrent admissions of one device: the second becomes a refresh.
- If another signing key holds it, the card is refused (`KEY_HELD`).
- If the `signPub` is a member with another key, the card is refused (`ANOTHER_KEY`).
- `namedByAnother` applies unchanged.

**The plan limit.** The `machines` limit counts **machine** members only. An auto-admitted client is already counted by the admitting host's `devices` limit, because only a paired device can be auto-admitted. So admitting one spends no machine slot, and a machine join sees the same room as it did before the device was admitted. The copy "This mesh has N machines" stays true. The inviter-run client join of #956 is counted the same way.

A client never sends records, heads or acks on this stream. The only thing it contributes is its own card, and the
admit is the host's record.

**Why admitting without asking is not a new capability.** A device paired with A already drives every member through
A's hc, over mesh lines A dials for it. The hc stream is owner-equivalent (revision 4 §4), so it can do anything on B
that B's own owner can. Admission changes only _where_ that reach comes from: directly instead of through A. It does
not change _what_ the device can reach. So the paired device's admission is approved by the pairing that already
happened. The inviter-run client join, a client that was never paired, still asks.

That argument holds only while A is a member, so it is enforced (§4, **admitter binding**). A client is authorized only
while the machine that admitted it is a current machine member. Revoking A, or A leaving, removes every client A
admitted from every member's authorization, which is exactly the reach those devices had through A before this
design.

**Old hosts.** `decodeHello` refuses an unknown stream at the handshake (`packages/crypto/src/payloads.ts`). A device
that meets an older host learns "not supported" with no side effect, and it keeps working through that host as it does
today.

## 3. The device's bundle (revision 4 §2, made concrete)

The device keeps, per mesh, the records it verified. They go in IndexedDB next to its device key, and are never sent
anywhere.

- **Anchor.** The first bundle is accepted only from a host whose Noise key the device pinned at pairing. The checks are
  `checkWelcome`'s, adapted to a client: every record passes `door` in order; exactly one `found`, whose id is the
  offer's mesh; the answering host is a **machine** member of the view with the hostId and Noise key this session
  authenticated; and the device is a **client** member of the view whose card holds its own sign key and this session's
  key.
- **Refresh.** After any member's session opens, the device runs the roster stream to that member. It does this once per
  session open, and at most once per 10 minutes per member. The member must already be a machine member of the
  device's held view, with the Noise key the session authenticated. Each record passes `door` against the **held** set
  before it is kept.
- **Merge** is a union with history retention. A response that omits a record cannot remove it, so a revoke the device
  holds is never erased.
- **The roster.** The roster is the paired members (as today) plus the **machine** members of `viewOf(held)`, which
  excludes revoked members, superseded keys and clients. Each learned member becomes a `MemberTarget` with its
  `hostId`, the view's name, its view Noise key as `hostKey`, and no `directUrl`. Learned members are kept apart from
  the saved roster: they are computed from the bundle, so a member that leaves the view leaves the roster with it.
- **Precedence.** A paired member wins over a learned member with the same `hostId`. The paired key is the one the
  owner checked by fingerprint, and a host that rekeys is re-paired, as today. A learned member never replaces a
  paired entry's key or `directUrl`.
- **Settling (revision 4 §2's readiness rule).** A learned member that refuses the device with 4401 has usually not yet
  synced the admit. For a learned member, that refusal is **not final**: it is not `DeviceNotPairedError` and never
  "Pair it again". The member's store keeps its retry ladder and shows the member as "settling". The ladder ends only
  when the held view stops naming the member, or stops naming the device.
- **Cold start never needs the inviter.** The held bundle names every member's key, so the device dials them all in
  parallel. The first one to answer refreshes the bundle.
- **The device revoked, or orphaned.** A held view in which the device is no longer a member drops every learned
  member. That covers the device's card revoked, and its admitter no longer a current machine member (§4). The device
  keeps only its paired members, which decide for themselves.
- **Keys.** The Ed25519 sign key is generated with `@noble/curves` (no WebCrypto Ed25519 needed). It is stored as
  raw bytes in the same IndexedDB store as the device key, which is the storage #1333 proved on WebKit. A browser
  that cannot store it simply never runs the roster stream, and works as today.

## 4. Revocation and the admitter binding

- **Admitter binding (closes the HIGH).** A client member is authorized only while the signer of its governing
  `admit` is a current **machine** member. `indexOf` (`apps/host/src/mesh/authorize-index.ts`) leaves such a
  client out of `members`. Its key then falls through to the paired-device check, so only a host that paired it
  directly still accepts it. Every host derives this from the same records, so no new record is needed. A
  `mesh revoke A` or `mesh leave` is itself a `mesh.json` write, so the index is rebuilt at the moment it matters
  and `closeRevoked` closes the orphaned clients' sessions. The device applies the same rule to its held view (§3).
- **From the mesh.** `doriface-host mesh revoke <device>` on any live member works today, and it resolves a client by its
  name or hostId. As the revoke propagates, `closeRevoked` closes the device's sessions on each member. This happens
  after propagation, not instantly across a partition (revision 4 §5).
- **Unpair on the admitting host.** This is an invariant on that host: _a client member this host admitted stays a
  member only while this host still pairs its key._ It is enforced in three places:
  1. At admit time, by the `devices.json` re-read inside the admit transaction (§2). An unpair that lands between the
     handshake and the admit makes the admit refuse, and nothing is signed.
  2. On `devices-changed` (the CLI's `devices revoke` and the app's revoke both send it). The running host signs a
     revoke for every client member whose governing admit is its own and whose `devicePub` is no longer paired.
  3. Once at start, which covers a revoke made while the host was down.

  The sweep also runs after every admit. When `devices.json` cannot be read, the sweep **signs nothing** and logs
  why, because a revoke burns the key mesh-wide and an unreadable file says nothing about what was removed.

- **Unpair is only as fast as the admitting host.** If A is stopped or partitioned, an unpair on A signs nothing until A
  runs and reaches the others. Until then B keeps accepting the device. This is a real difference from today, where a
  device unpaired on A reached nothing. So `devices revoke` of a device that is a client member says so in words: the
  mesh membership ends when this host is running and reachable, and `doriface-host mesh revoke <name>` on any running
  member ends it now. The command prints that line whether the host is running or not.
- **Unpair on a host that did not admit the device** removes only that host's paired entry. The device stays a client
  member and that host keeps accepting it as one. Before this design the device reached that host through A anyway,
  so this is no change in reach. `devices revoke` there prints the same `mesh revoke` hint.
- **A burned key.** After a revoke, the device's key is refused for pairing everywhere (`claimsKey`). A browser that is
  paired again after a revoke needs a fresh device key, which is a follow-up (filed with this PR).

## 5. Threat model

| threat                                             | answer                                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a member feeds the device a forged roster          | every record passes `door` against the held set, and membership is `viewOf`. Only a member can admit, and the view's own rules hold. Trusting a member's records is exactly the trust A already places in that member              |
| the admitting host is revoked, or leaves           | the admitter binding (§4) de-authorizes every client it admitted, on every member, at the write that revokes it                                                                                                                    |
| a device is unpaired on its admitting host         | revoked mesh-wide once that host runs and reaches the others. Until then it reaches B: §4 states this, and `devices revoke` points to `mesh revoke` on a live member                                                               |
| unpair races an admit                              | the admit re-reads `devices.json` inside its `mesh.json` transaction, and the sweep runs after every admit                                                                                                                         |
| a revoked member hides its revoke from a device    | union with history retention: a revoke the device holds is never dropped. A device that never learned the revoke dials the revoked member, which is the partition limit stated in §4                                               |
| the relay redirects a dial                         | each session is Noise IK, pinned to the member's Noise key from the verified view. The relay sees nothing                                                                                                                          |
| the device poses as a machine                      | its card is `kind: "client"`. Its key is kept out of the Noise map, so it is refused on `"mesh"`, refused on `"roster"` as a machine, and the `core.id` rule is unchanged                                                          |
| the device admits others, or votes                 | it signs nothing but its own card. A client is not a record author or witness (`packages/mesh/src/view`)                                                                                                                           |
| a card is replayed on another host or session      | the card is bound to that session's offer nonce and to its authenticated key                                                                                                                                                       |
| unbounded work from the stream                     | same parser bounds as a welcome (`MAX_RECORDS`, 2048-byte bodies, 4 MiB unread). An offer goes only to a paired device or a client member, and the device refreshes at most once per session open, at most every 10 min per member |
| an old machine that cannot read a client admission | `admissionRefusal` withholds the admit until every machine has shown it reads the format (revision 4 §7). Until then the device gets the refusal sentence and works as today                                                       |

## 6. Compatibility

| case                                                                     | behaviour                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device already paired with one host (new build both sides)               | its next session to that host runs the roster stream, and it is admitted and learns the members. No re-pairing                                                                                                   |
| new device, older host                                                   | the roster stream is refused at the handshake. The device works through that host as today, and retries on its next session open                                                                                 |
| older device, new host                                                   | never opens the roster stream. Nothing changes                                                                                                                                                                   |
| a mesh with a machine that has not shown format support                  | admission is refused with the readiness sentence. The device works as today                                                                                                                                      |
| a mesh at its plan's `machines` limit                                    | a device is still admitted: clients do not count toward `machines`, and they are counted by the admitting host's `devices` limit. A machine join at limit-1 still succeeds after any number of client admissions |
| A stopped right after the admit, before B synced it                      | B refuses the device with 4401. For a learned member that is "settling", not "Pair again", and B is retried on the ladder until it accepts                                                                       |
| host in no mesh                                                          | `refused "this host is in no mesh"`. The roster stays the paired host                                                                                                                                            |
| desktop app on its own host (loopback)                                   | not changed. The shell's own host is a machine, and loopback carries no device key                                                                                                                               |
| direct (LAN) address                                                     | a paired member keeps its `directUrl`. Learned members go through the relay                                                                                                                                      |
| `doriface-host connect --mesh`, mesh lines, gossip                       | unchanged                                                                                                                                                                                                        |
| push                                                                     | unchanged: a device's push association stays the paired entry on the host it paired with (revision 4 §4)                                                                                                         |
| B listed twice while A is up (A's hc lists B, and B is a learned member) | the same as two pairings today (#1331). Showing machines per member from the client's own sessions is #1296                                                                                                      |
| mesh status / Machines                                                   | the device appears as a `client` member, and the approval and status rows already speak about clients (#956)                                                                                                     |

## 7. Rollout and tests

Two pull requests. The second depends on the first's wire.

1. **Host: the roster stream** (`Part of #942`): `"roster"` in the hello's stream union; its authorization column; the
   offer/card/admit/records exchange; the revoke-on-unpair invariant. Unit tests, all on the real index and store:
   - a paired device is admitted as a client and receives the records;
   - a client member gets a refresh and nothing is signed;
   - a machine's Noise key, a machine's device key, a revoked key and an unknown key are refused;
   - a card bound to another nonce, another key or kind `"machine"` is refused;
   - not format-ready means refused, and the admit is not signed;
   - in no mesh means refused, and nothing is founded;
   - `devices revoke` of an admitted client signs its revoke and closes its sessions;
   - the old stream union still refuses `"roster"` (decode test);
   - **admitter binding:** after `mesh revoke` or `mesh leave` of A, a client A admitted is refused on B's hc stream, and its open session there closes;
   - **race:** a device unpaired between the handshake and the admit is not admitted, and nothing is signed;
   - the sweep signs nothing when `devices.json` cannot be read;
   - `devices revoke` of a client member prints the `mesh revoke` hint, whether the host is running or not;
   - **plan:** with `machines` = N, a client admission at N-1 and at N machines succeeds, and a machine join at N-1 still succeeds after it;
   - a concurrent second admission of the same device is a refresh, not `ANOTHER_KEY`.
2. **Web: membership and the learned roster** (`Fixes #942`): the device's sign key, the bundle store and its checks,
   learned members in `MeshConnections`, and refresh. Unit tests:
   - a welcome from A teaches B, and B is dialled;
   - a record that fails `door` is refused and nothing is kept;
   - a refresh that omits a held revoke keeps it;
   - a view that revokes the device drops the learned members;
   - an older host's refusal leaves the roster as it was;
   - a learned member's 4401 is "settling" and retried; a paired member's 4401 is still "Pair it again";
   - a paired member wins over a learned one with the same hostId;
   - a held view that orphans the device (its admitter revoked) drops the learned members.

   Acceptance on two real machines (the fake relay cannot hold two uplinks, #1297): a device paired with A only, A's
   host stopped, B still listed and a terminal opened on it.

## 8. Revision 1's findings and where they are answered

| finding                                                    | answered in                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| HIGH: a client outlives its admitting host                 | §4 admitter binding; §2 the argument is stated as enforced; tests    |
| MEDIUM: unpair is no longer immediate or partition-proof   | §4 "only as fast as the admitting host"; threat-model rows; CLI hint |
| MEDIUM: the unpair/admit race                              | §2 re-read inside the transaction; §4 sweep after every admit; test  |
| MEDIUM: auto-admission spends the `machines` limit         | §2 plan limit; compatibility row; tests at N-1 and N                 |
| MEDIUM: a learned member's 4401 becomes "Pair it again"    | §3 settling; compatibility row; tests                                |
| LOW: `isRejoin` has no client branch                       | §2 the client branch                                                 |
| LOW: the sweep's behaviour on an unreadable `devices.json` | §4 signs nothing                                                     |
| LOW: unpair on a host that did not admit                   | §4                                                                   |
| LOW: precedence, key storage, B listed twice, burned key   | §3 precedence and keys; compatibility row; §4 burned key (follow-up) |
