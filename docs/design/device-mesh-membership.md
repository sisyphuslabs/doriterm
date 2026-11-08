# A paired device becomes a client member, and learns the mesh

Status: draft for the design gate, 2026-11-08. Issue #942. This builds on [client-mesh-member.md](client-mesh-member.md)
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

| who the session key is                                       | the host                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| a current **client member** whose card has this `signPub`     | sends the records (a refresh), and admits nothing                                                                                    |
| a **paired device** of this host that is no member            | admits the card: `admissionRefusal` (format readiness), the plan's `machines` limit, the twin/collision checks of `isRejoin` applied to the client's keys, then signs an `admit` exactly as `serveJoin` does; sends the records |
| a machine member's Noise or device key                       | refused at the handshake: a machine syncs on `"mesh"`                                                                                |
| a revoked or superseded key, or an unknown one               | refused at the handshake (4401)                                                                                                      |
| any key, while this host is in no mesh                       | `refused "this host is in no mesh"`: no mesh is founded for a device                                                                 |

A client never sends records, heads or acks on this stream. The only thing it contributes is its own card, and the
admit is the host's record.

**Why admitting without asking is not a new capability.** A device paired with A already drives every member through
A's hc, over mesh lines A dials for it. The hc stream is owner-equivalent (revision 4 §4), so it can do anything on B
that B's own owner can. Admission changes only *where* that reach comes from: directly instead of through A. It does
not change *what* the device can reach. So the paired device's admission is approved by the pairing that already
happened. The inviter-run client join, a client that was never paired, still asks.

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
- **Cold start never needs the inviter.** The held bundle names every member's key, so the device dials them all in
  parallel. The first one to answer refreshes the bundle.
- **The device revoked.** A held view in which the device's own client card is revoked drops every learned member, and
  the device keeps only its paired members (which refuse it too, see §4).

## 4. Revocation

- **From the mesh.** `doriface-host mesh revoke <device>` on any member is an existing command, and it already resolves
  a client by its name or hostId. As the revoke propagates, `closeRevoked` closes the device's sessions on each member.
  This happens after propagation, not instantly across a partition (revision 4 §5).
- **From the host it paired with.** This is new, and is an invariant on the admitting host: *a client member that this
  host admitted stays a member only while this host still pairs its session key.* `devices revoke` (the CLI, or the app's
  revoke) already tells the running host `devices-changed`. The host then signs a revoke for every client member whose
  admit is its own and whose `devicePub` is no longer paired. It also checks this once at start, which covers a revoke
  made while the host was down. Revoking a device on A therefore revokes it mesh-wide. Because a roster refusal
  overrides a paired entry, a member that also paired the device refuses it too.
- A device whose key is compromised is today's risk unchanged: it already controls every member through A.

## 5. Threat model

| threat                                                    | answer                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a member feeds the device a forged roster                 | every record passes `door` against the held set, and membership is `viewOf`. Only a member can admit, and the view's own rules hold. Trusting a member's records is exactly the trust A already places in that member                                                                      |
| a revoked member hides its revoke from a device           | union with history retention: a revoke the device holds is never dropped. A device that never learned the revoke dials the revoked member, which is the partition limit stated in §4                                                                       |
| the relay redirects a dial                                 | each session is Noise IK, pinned to the member's Noise key from the verified view. The relay sees nothing                                                                                                                                                                      |
| the device poses as a machine                              | its card is `kind: "client"`. Its key is kept out of the Noise map, so it is refused on `"mesh"`, refused on `"roster"` as a machine, and the `core.id` rule is unchanged                                                                                               |
| the device admits others, or votes                         | it signs nothing but its own card. A client is not a record author or witness (`packages/mesh/src/view`)                                                                                                                                                        |
| a card is replayed on another host or session              | the card is bound to that session's offer nonce and to its authenticated key                                                                                                                                                                                   |
| unbounded work from the stream                             | same parser bounds as a welcome (`MAX_RECORDS`, 2048-byte bodies, 4 MiB unread). An offer goes only to a paired device or a client member, and the device refreshes at most once per session open, at most every 10 min per member                                       |
| an old machine that cannot read a client admission         | `admissionRefusal` withholds the admit until every machine has shown it reads the format (revision 4 §7). Until then the device gets the refusal sentence and works as today                                                                                 |

## 6. Compatibility

| case                                                  | behaviour                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device already paired with one host (new build both sides) | its next session to that host runs the roster stream, and it is admitted and learns the members. No re-pairing                                                                        |
| new device, older host                                | the roster stream is refused at the handshake. The device works through that host as today, and retries on its next session open                                                 |
| older device, new host                                | never opens the roster stream. Nothing changes                                                                                                                                       |
| a mesh with a machine that has not shown format support | admission is refused with the readiness sentence. The device works as today                                                                                                       |
| host in no mesh                                       | `refused "this host is in no mesh"`. The roster stays the paired host                                                                                                                  |
| desktop app on its own host (loopback)                 | not changed. The shell's own host is a machine, and loopback carries no device key                                                                                                                   |
| direct (LAN) address                                   | a paired member keeps its `directUrl`. Learned members go through the relay                                                                                                             |
| `doriface-host connect --mesh`, mesh lines, gossip     | unchanged                                                                                                                                                                         |
| push                                                  | unchanged: a device's push association stays the paired entry on the host it paired with (revision 4 §4)                                                                             |
| mesh status / Machines                                | the device appears as a `client` member, and the approval and status rows already speak about clients (#956)                                                                          |

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
   - the old stream union still refuses `"roster"` (decode test).
2. **Web: membership and the learned roster** (`Fixes #942`): the device's sign key, the bundle store and its checks,
   learned members in `MeshConnections`, and refresh. Unit tests:
   - a welcome from A teaches B, and B is dialled;
   - a record that fails `door` is refused and nothing is kept;
   - a refresh that omits a held revoke keeps it;
   - a view that revokes the device drops the learned members;
   - an older host's refusal leaves the roster as it was.

   Acceptance on two real machines (the fake relay cannot hold two uplinks, #1297): a device paired with A only, A's
   host stopped, B still listed and a terminal opened on it.
