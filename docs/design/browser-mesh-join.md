# A browser joins a mesh as its own member

Status: stage 2 of #1386, 2026-11-08. Implements §4 of `docs/design/device-mesh-membership.md` (the #1377 design, as
built; its §0 maps each section to the pull request that built it) as far as the join itself; the roster-as-the-unit
(stage 3) and the join code that replaces the fingerprint screen (stage 4, #1377 §9) are not in this change.

## 1. What a browser may join

Only a **mesh invite**: a link from `doriface-host mesh pair` (`&m=1`) or a typed code for such an offer. #1377
§4 names the mechanism: the existing mesh join on a mesh offer, with a `kind: "client"` card signed by the browser's
own Ed25519 key and bound to its X25519 device key. The design as built keeps that mechanism (its §3 table); nothing in
it widens what a link admits, and nothing here does either.

The split is decided in one place, `packages/mesh/src/join/invite.ts`, not in each caller. `meshInviteOf(target)`
refuses a device pairing link ("this link pairs a device: run doriface-host mesh pair on the member") and a bare hostId
("mesh join takes a mesh pairing link or code, not a hostId"), in the words `apps/host/src/mesh/join-dial.ts` used
before, and returns a `MeshInvite` proof that the shared `JoinerContext` requires. The host adapter
(`apps/host/src/mesh/join.ts`) and the browser (`apps/web/src/mesh/join.ts`) both obtain the proof from that one
function, so the two cannot drift, and a caller cannot reach `runJoiner` without it: a device link is refused before
anything is dialed, and the type refuses a context built without the proof. A typed code is admitted by the guard and
judged by the inviter, because the relay's slot answer carries no kind (#727): the inviter's `claimCode(.., mesh)`
(`apps/host/src/state/pairing.ts`) closes a mesh-stream pairing on a device offer with 4401.

## 2. What proves membership, now that nobody compares a fingerprint

This is a chain of checks the protocol already ran for a machine joiner; the browser runs the same chain through the
shared joiner (`packages/mesh/src/join/joiner.ts`). It is not "the check was skipped": the fingerprint screen asked a
person to confirm a key that the handshake had already authenticated, and that cryptographic step is unchanged.

1. **The inviter is the key the invite names.** The browser dials the relay with the inviter's hostId and runs Noise
   IKpsk2 as initiator with its own device key as static and `remoteStatic` = the invite's `k=` key
   (`apps/web/src/mesh/join.ts`, `dialInviter`). For a link the psk is the link secret the person received out of band;
   for a code it is the CPace output of the typed code. A host that does not hold the invite's secret cannot complete
   the handshake, and a relay cannot read or alter the session.
2. **The browser's card is bound to that session.** The inviter checks the card against the offer it sent (mesh id,
   its own signPub, a fresh nonce) and requires `card.noisePub` to equal the Noise static that just proved itself
   (`apps/host/src/mesh/invite.ts`, `checkCard`). A card replayed from another session or signed for another offer is
   refused.
3. **The welcome proves the mesh, not the inviter's word.** `checkWelcome` runs every record of the welcome through the
   door in order, requires exactly one `found` whose id is the offered mesh, requires the dialed hostId and Noise key
   to be the inviting member's in the resulting view, and requires this browser's own signing key to be a member with
   the device key it just used. A welcome for another mesh, one that admits the browser under another key, or one whose
   inviter is not the key the browser dialed is refused, and nothing is stored.
4. **Membership is the bundle, kept.** The membership record (`apps/web/src/mesh/membership.ts`) is the checked
   welcome plus the browser's signing key. The member list is `viewOf(records)`, the same function every host runs, so
   a browser and a machine looking at the same records see the same members with the same names and keys.

What the chain does **not** prove, said plainly: for a typed code, that the inviting person is who the joiner thinks
it is when the code has leaked. The code's secrecy is the premise of step 1. #1377 §9 adds a committed join code so
both screens can be compared when that premise fails; until it lands, the browser's code path has the same strength
the host CLI's `mesh join <code>` has today, and the link path is pinned to the key inside the link.

## 3. What the host's `JoinerContext` needed, and what the browser supplies

| host (`origin/dev` before the lift)             | browser                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity: HostIdentity` from the state dir     | an Ed25519 pair in IndexedDB (`apps/web/src/mesh/identity.ts`, `loadSignKey`) and the existing X25519 device key (`apps/web/src/connection/device-key.ts`) as the Noise static |
| `mesh: MeshStore` (`mesh.json`) and its `adopt` | `MembershipStore.adopt` over the device's IndexedDB store; a membership of another mesh wins, as a `mesh.json` that appeared meanwhile does on a host                          |
| `own.name` from `--name` or the hostname        | `meshNameOf(deviceName())`: the device name slugged to herdr's machine-name rule                                                                                               |
| `own.hcId` from the herdr core                  | `clientIdOf(signPub)`: a browser runs no core, so a stable id derived from its signing key stands in                                                                           |
| `own.devicePub` from `device-key.json`          | the same device key, as the card's `devicePub`: it is the session key a host looks up for a client                                                                             |
| the CLI's `--yes` and fingerprint confirmation  | none; the early refusals are the shared guard and "this browser is a member already"                                                                                           |

## 4. The member record and the "this device" question (Q, 2026-11-08)

- **Same list from every member.** Every member, browser or machine, computes `viewOf(records)`; the browser's entry
  is the one whose `signPub` equals `membership.signPub`. No field says "the one looking", so a settings screen can
  mark the browser's own row by key equality instead of a special row. The fields the record needs for that are
  `records` and `signPub`; `inviter`, `relayUrl` and `joinedAt` are provenance.
- **Revocable from anywhere.** A revoke is a signed record whose subject names a member's `signPub`
  (`packages/mesh/src/records/types.ts`, `RevokeSubject`), written by any machine member from its own mesh file. The
  browser's `signPub` is in its card, so any machine can revoke it with no loopback to the computer it joined through.
  Nothing this record lacks blocks that. What it does not give is a browser revoking **itself**: clients are not record
  authors, so `leave` from the browser is the `"roster"` stream of #1377 §5 and §10, a protocol step, not a field.
- **Nothing here needs undoing for stage 3.** The connection roster shape (`MemberTarget`) is derived from the
  membership (`reachableTargets`), not written by the join; the "This browser" row in settings is untouched and goes
  with the roster, in one change.

## 5. What a session to a member is, after the join

The join's own session is closed once the welcome is stored: a client never syncs over the mesh stream, and the
inviter closes that session 4401 when the join is over (`apps/host/src/mesh/host-sync.ts`, `#attach`). Reaching a
member is then an ordinary web connection over the relay with the browser's device key (`stream: "hc"`), which a host
admits as a client once its own view holds the admission (`apps/host/src/e2ee/authorize.ts`, `sessionPeer`,
`AuthorizeIndex.client`). The two-process test (`tests/relay/browser-join.test.ts`) opens such a session to the member
that did **not** invite the browser, after that member learned the admission by gossip.

## 6. A host that has no mesh yet cannot admit a browser as its first member (finding)

`serveJoin` founds the mesh inside the join that needs it (`apps/host/src/mesh/invite.ts`, `meshIdFor`) and then asks
`formatReady()` before writing a client admission (`admissionRefusal`). That readiness reads the running sync's gossip
(`apps/host/src/mesh/sync-hooks.ts`), and sync starts only when a `mesh.json` exists at host start or on
`mesh-changed` (`apps/host/src/mesh/host-deps.ts`, `host-sync.ts`): on a host that founded its mesh a moment ago the
gossip is still absent, so the client card is refused with "a client can join once every machine in this mesh reads the
new format". A machine joiner is not gated this way. The browser surfaces the refusal and stores nothing; the fix is on
the host (start sync, or let a cohort of one count as ready, when the mesh is founded by the join itself) and is not in
this change.
