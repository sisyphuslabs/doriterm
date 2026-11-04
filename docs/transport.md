# doriface transport contract v1.5

This is the binding wire contract for every doriface package. Each rule below is the current one; the change log at the end records what each revision changed.

Layering, outermost first:

1. WebSocket, binary messages only, permessage-deflate off. The only text messages are the ones listed under "Relay text messages".
2. Relay routing header (relay path only, between relay and host; clients never see it).
3. Noise record layer (E2EE, `@doriface/crypto`): one WebSocket message = one Noise message.
4. Plaintext = a chunk of herdr-core's raw `hc connect` byte stream (JSON-RPC lines, then frames). The host never parses it; it pipes it to `hc connect`.

## Identities

- Host signing key: Ed25519 (`@noble/curves/ed25519`). `hostId` = lowercase base32 (RFC 4648, no padding) of the first 16 bytes of SHA-256(signPub) -> 26 chars.
- Host Noise static key: X25519.
- Client device static key: X25519, generated once per device. The web generates it as a non-extractable WebCrypto X25519 `CryptoKey` stored in IndexedDB, and uses `subtle.deriveBits` for the static DHs. When WebCrypto has no X25519 (feature check), it falls back to raw key bytes in IndexedDB. Ephemeral DHs always use `@noble/curves`. So `@doriface/crypto` takes the local static DH as an async function `dh(pub): Promise<Uint8Array>`.
- What a non-extractable key protects: same-origin script can still _use_ the key while the page is open, but it cannot copy the key bytes out. The raw-bytes fallback offers no such protection.
- Host fingerprint shown to people: the first 20 bytes of SHA-256(noiseStaticPub) (160 bits), uppercase hex, as 10 groups of 4 characters (`3FA9 4C0E ...`). `doriface-host pair` and `doriface-host fingerprint` print it in that form.
- Pairing secrets, one set per pairing offer: the 8-character typed code (25 secret bits, used only as a CPace password) and a 32-byte random link secret (carried only in the pairing URL fragment). Neither is ever used directly as a key. Typed-code pairing binds `hostId`, the host Noise static key and the slot into the PAKE, so a code typed for one host cannot be used against another.
- Mesh id: lowercase base32 (RFC 4648, no padding) of the first 16 bytes of SHA-256 of the mesh's founding record body (26 characters).
- Mesh signatures, all Ed25519 by a host signing key: records over `doriface-mesh/1` || SHA-256(body); member cards, by the card's subject, over `doriface-mesh/1 card` || SHA-256(body). With the relay's `doriface-relay-v1`, the three prefixes keep the uses apart.

## Pairing

- `doriface-host pair` opens one pairing offer (replacing any pending one) and prints a QR code, the URL `<web origin>/pair#h=<hostId>&k=<noiseStaticPub b64url>&s=<signPub b64url>&p=<link secret b64url>&r=<relay url>`, the typed code, the fingerprint, the hostId and the expiry. The fragment never reaches a server. The link secret is 32 random bytes (43 base64url characters without padding). The desktop app opens the same fragment as `doriface://pair#h=…&k=…&s=…&p=…&r=…` (exactly these five keys, once each) and keeps a click on `https://doriface.omo.dev/pair#…` inside the app; every client moves the fragment into memory and out of the URL and history before it renders or dials anything.
- `doriface-host mesh pair` opens the same kind of offer for a machine join: its URL adds `&m=1`, and the offer admits a host into the mesh (see "Mesh") instead of pairing a device. A device pairing on a mesh offer, or a join on a device offer, is closed with 4401 before any answer. On a mesh offer, success stores no device: the inviting member shows the joiner's name, hostId and fingerprint and admits it only after approval on that member (its terminal, or a client device paired to it), unless the offer was opened with `--auto`.
- A paired-device store never holds a key that belongs to a mesh member or a revoked mesh member (their Noise key or the device key their card names).
- An offer lives 10 minutes and is single use: the first pairing that completes, by either path, burns the code and the link secret together.
- Typed code: 8 characters from the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, displayed as `XXXX XXXX`. Input is normalized: uppercase, spaces and `-` dropped, `O` read as `0`, `I` and `L` read as `1`. The first 3 characters are the relay pairing slot; the last 5 are the secret (2^25 values), which never leaves the two devices and is never sent in any form an observer can test offline.
- While the typed code is open, the host's relay uplink registers the slot with a PAIR_SLOT control frame (see "Relay"). A client that has only the typed code calls `GET /v1/pair/<slot>` and gets `{hostId, noiseStaticPub, signPub}`: `hostId` is the 26-character lowercase base32 string defined above, and the two public keys are base64url strings without padding. That answer is untrusted; the client checks that `hostId` matches `signPub`, the person confirms the fingerprint, and the PAKE below authenticates it. The relay answers each PAIR_SLOT with a PAIR_SLOT_ACK (see "Relay"); on a collision the host draws a new code and registers again. A QR/URL pairing already carries hostId and keys, so it skips the slot lookup.
- Failed typed-code attempts: the host counts every typed-code attempt it answers (see "Session kinds" below) and persists the count with the offer. After 10 answered attempts it retires the typed code: it clears its relay slot and answers no further typed-code attempt (4429). The link secret stays valid until the offer expires. Each answered attempt tests exactly one guess, so an attacker's chance to learn a code is at most 10 in 2^25 per offer, whatever the relay does. Attempts that the host refuses before answering are not counted. Anyone who can make 10 answered attempts (through the relay's budget below) can retire a code but cannot learn it; the remedy is the QR/link or a new code.
- On success the host appends `{clientStaticPub, name, pairedAt}` to its paired-devices store and burns the offer. The offer is burned before the device is stored, so a failed store never leaves it usable.
- Revoking a device removes it from the store and closes its live sessions.

### Session kinds

The first message a client sends on every session (relay or direct) starts with one kind byte:

| kind   | Name      | Rest of the first message                      | Noise protocol                          | Prologue                                              |
| ------ | --------- | ---------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `0x01` | session   | Noise message 1                                | `Noise_IK_25519_ChaChaPoly_BLAKE2s`     | `doriface/1` \|\| hostId \|\| `0x01`                  |
| `0x02` | pair-code | `sid` (16) \|\| `Ya` (32) \|\| Noise message 1 | `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s` | `doriface/1` \|\| hostId \|\| `0x02` \|\| sid \|\| Ya |
| `0x03` | pair-link | Noise message 1                                | `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s` | `doriface/1` \|\| hostId \|\| `0x03`                  |

`doriface/1` is its 10 UTF-8 bytes and hostId its 26 ASCII characters. Any other kind byte, or a first message outside its kind's size bounds, is closed with 4400 and never answered. The host's first message is Noise message 2, preceded for kind `0x02` by the host's CPace share `Yb` (32 bytes). The client's first transport record after message 2 has an empty plaintext; it confirms the keys, and the host stores a paired device, or releases IK early data, only after decrypting it. `lv_cat` and `prepend_len` are as in draft-irtf-cfrg-cpace-21 section 6.3 and Appendix A.1: each field is prefixed with its length in LEB128 and the results are concatenated.

A v1.2 first message is never answered. It has no kind byte, so its first byte is the first byte of a random ephemeral key: an unknown kind, or a message outside the kind's size bounds, is closed before any crypto; a v1.2 message that passes the size bounds of kind `0x02` or `0x03` fails message-1 authentication under the v1.3 prologue; one that starts with `0x01` fails message 1 because the IK prologue now ends in `0x01`. Each is closed with 4400.

- Session (`0x01`): with `stream` absent or `"hc"`, the host admits a current mesh member's Noise static key (an hc line; every hc `hello`'s `core.id` must be that member's card `hcId`) or a key in its paired-devices store, checked in that order. It refuses a key of a revoked mesh member, and on the device path any device session whose hc `hello` claims a member's `hcId` (4401). The host reads the plain hc lines of these sessions until the `hello` that switches the connection to frames, and nothing after it: each line must be a JSON-RPC 2.0 request of at most 4096 bytes including its LF, using only well-formed strings and integer literals of at most 15 digits, the first line must be a `hello` with an `id`, and a `hello`'s `params` must be valid for hc (`generation` absent, `null` or `1`); otherwise the session is closed with 4400. With `stream:"mesh"` it admits only a current mesh member (4401). These sessions are accepted on the direct path too. A relay session opened with `?pair` carries only pairing; kind `0x01` on it is 4401.
- Pair-link (`0x03`, the QR/URL path): psk = HKDF-SHA512(ikm = link secret, salt = empty, info = lv_cat(`doriface/1.3 pair-link psk`, UTF-8 hostId, noiseStaticPub), 32 bytes). The client dials an ordinary relay session (no `?pair`), or the direct path.
- Pair-code (`0x02`, the typed path): CPace, cipher suite CPACE-RISTR255-SHA512 of draft-irtf-cfrg-cpace-21 (section 8.3), initiator-responder mode with the client as initiator A and the host as responder B:
  - PRS = UTF-8 of the 8 normalized code characters.
  - CI = lv_cat(`doriface/1.3 CPace pair-code`, `A=device`, `B=host`, UTF-8 hostId, noiseStaticPub, UTF-8 slot).
  - sid = 16 random bytes chosen by the client per attempt; ADa = ADb = empty; transcript = transcript_ir. Because the client chooses sid, an attacker can precompute the generators of every code for a sid of its choice; that makes each online attempt cheaper to compute but adds no attempt and allows no offline test.
  - Generator, scalar sampling (32 random bytes, the top 4 bits cleared, zero redrawn), `scalar_mult_vfy` (an invalid or identity encoding aborts) and ISK are exactly as the draft specifies. K is never exposed.
  - psk = HKDF-SHA512(ikm = ISK, salt = empty, info = `doriface/1.3 pair-code psk`, 32 bytes), used as the IKpsk2 psk, which Noise mixes after the `se` token of message 2.
  - The host accepts kind `0x02` only on a relay session opened with `?pair=<slot>` whose slot belongs to its live, unretired offer. On the direct path, on an ordinary relay session, or for another slot it closes with 4401 without answering. Before answering it checks `Ya` and message 1, then records the attempt durably. If the host cannot record the attempt it closes with 1011 and answers nothing. Reaching 10 retires the code for new attempts; sessions the host has already answered may still complete.

Message sizes: a client's first message is at most 4449 bytes for kind `0x01`, 401 for `0x02` and 353 for `0x03`. The host's first message is at most 304 bytes (336 for `0x02`).

### Handshake payloads

- Every handshake payload starts with one JSON line: a UTF-8 JSON object followed by LF (0x0A), at most 256 bytes including the LF, whose `v` member is the number `1`. Receivers ignore unknown members. A payload that breaks a rule below fails the handshake with 4400.
- Message 1 may carry `stream`. On a session (`0x01`): absent or `"hc"` (the plaintext after the handshake is the `hc connect` byte stream; up to 4096 early stream bytes) or `"mesh"` (the mesh stream; no early bytes, else 4400). On a pairing (`0x02`, `0x03`): absent (a device pairing) or `"mesh"` (a machine join). Any other value, or `"hc"` on a pairing, is 4400.
- Message 1 of a pairing: `{"v":1,"name":"<name>"}` or `{"v":1,"name":"<mesh name>","stream":"mesh"}` and nothing after the line. A device name is checked after trimming leading and trailing white space (ECMAScript `String.prototype.trim`): the trimmed name is 1 to 64 UTF-16 code units, well-formed (no lone surrogates), and contains no character of the Unicode categories Cc, Cf, Zl or Zp, otherwise the handshake fails with 4400. The host stores the trimmed name. A mesh name follows herdr-core's machine-name rule: 1 to 32 characters of `a-z`, `0-9`, `-`, `_`, `.`, starting with a letter or digit, and not shaped like a terminal id (`t` followed by `1`-`9` and then only `0123456789bcdfghjkmnpqrstvwxyz`).
- Message 2 (every kind): `{"v":1,"lan":[...]}` and nothing after the line. `lan` holds at most 8 strings, each `ws://<IPv4 literal or bracketed IPv6 literal>:<port 1-65535>/v1/e2ee` that parses as a WHATWG URL; never a host name. The host sends the longest leading run of its LAN URLs that keeps the line within 256 bytes. A client refuses the whole reply if any entry breaks this rule.
- A handshake that has not completed within 10 s is closed with 4408, and so is one that buffers more than 4 MiB of unread bytes.

### What a relay can learn during pairing

| Path                               | Where the client gets the host's static key    | What a malicious relay can do                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QR / URL (`0x03`)                  | the URL fragment, which never reaches a server | Nothing beyond sizes and timing. It cannot read message 1 (it is encrypted to the real host key), and the psk comes from a 256-bit secret it never sees, so it has nothing to test, online or offline.                                                                                                                                                                             |
| Typed code (`0x02`), honest lookup | the relay's `GET /v1/pair/<slot>` answer       | It sees the slot, sid, both CPace shares and the Noise ciphertexts. None of them depends on the code except through the CPace key, which needs a Diffie-Hellman value the relay cannot compute, so it cannot test a guess offline. Sessions it opens itself each give it one online guess per answer the host sends, and the host answers at most 10 per offer.                    |
| Typed code (`0x02`), lying lookup  | the relay's `GET /v1/pair/<slot>` answer       | If it answers with its own static key, it can read message 1 (the device name and the device's public static key) and gets one online guess per attempt the person makes. It cannot pass the attempt on to the real host, because the PAKE is bound to the host identity and slot the client was given, and the fingerprint check shows the person a key that is not their host's. |

So message 1 carries nothing secret, every code guess costs an answer from the real host, and the typed-code UI keeps the fingerprint confirmation step.

Residual risk: `hostId` binds only `signPub`, so a lying lookup can return the real `hostId` and `signPub` with a substituted Noise static key and still pass the client's `hostId` check. The PAKE then gives the substitute one online guess per attempt and no way to reach the real host, and only the fingerprint check catches the substitution. Signing the PAIR_SLOT key with `signPub` would remove this row; it is a planned relay change (#22).

## Record layer

- Noise transport messages use ChaCha20-Poly1305 (`@noble/ciphers`, synchronous) with 64-bit counter nonces as the Noise spec defines.
- Maximum plaintext per message: 65519 bytes. The sender chunks larger stream writes; the receiver concatenates in order.
- Rekey (Noise `REKEY()`) every 2^20 messages per direction. The nonce `n` is not reset at rekey.
- Any decryption failure closes the socket with code 4400. No reordering is tolerated, because WebSocket is ordered.
- Reconnect always runs a fresh IK handshake (1 RTT; msg1 may carry the first stream bytes). Resuming without a repaint is deferred.
- API: `secureLink(link: ByteLink, opts): Promise<SecureLink>` for the initiator and responder roles. `ByteLink` is `@doriface/client`'s interface (`send(bytes)`, `onData(cb)`, `onClose(cb)`, `close()`), and `SecureLink` is a `ByteLink` that also exposes the authenticated remote static key.

## Relay (Cloudflare Workers + Durable Objects)

- Default public relay: `https://relay-doriface.omo.dev`. The relay implementation is a separate private service; this section is its public contract, and any server that implements it can stand in.
- `GET /healthz` -> `{ok:true, version}`.
- Host uplink: `GET /v1/host/<hostId>` (WebSocket). The relay sends a 32-byte random challenge as the first binary message. The host answers with `signPub(32) || Ed25519-signature(64)` over `"doriface-relay-v1" || relayOrigin || hostId || challenge`, where `relayOrigin` is the exact `wss://host[:port]` the host dialed. The relay rebuilds `relayOrigin` from its own request URL and checks the signature and that `hostId` matches signPub; otherwise it closes with 4403. Binding the origin stops a second relay from replaying a challenge from this one. One uplink per hostId; a newer authenticated uplink replaces the old one, which the relay closes with 4409, and the old uplink's client sessions are closed with 4404.
- Client: `GET /v1/client/<hostId>` (WebSocket). There is no relay-level auth (E2EE authenticates). An offline host closes the socket with 4404. A typed-code pairing session adds `?pair=<slot>`: the relay charges it to that slot's pairing budget, refuses it with 4410 when the slot is not registered to this hostId, and sends the host an OPEN whose payload is the 3 slot characters (an ordinary OPEN has no payload). A QR/URL pairing is an ordinary session.
- Session admission: a client session counts against the 32-session cap only after the host has sent its first DATA on it. Before that it is pending: at most 8 pending sessions per host, with 10 s to the host's first DATA (else close 4408). When the pending cap is full, the relay evicts the pending socket from the source IP that holds the most pending sockets. Connections are also rate limited per source: 60 WebSocket upgrades (host uplinks and client sessions together) per source per minute, the 61st refused with 4429, and 20 `GET /v1/pair/<slot>` lookups per source per minute, the 21st refused with HTTP 429.
- One Durable Object per hostId (`idFromName(hostId)`), using the WebSocket Hibernation API. Socket attachments carry `{role, sessionId}`.
- Relay <-> host multiplexing frame: `[type u8][sessionId u32 LE][payload]`.
  - 1 OPEN: no payload, or the 3 slot characters for a pairing session.
  - 2 DATA: opaque bytes.
  - 3 CLOSE: payload = u16 LE close code.
  - 4 PAIR_SLOT (host to relay only, sessionId 0): payload = `slot (3 ASCII) || noiseStaticPub (32)` = 35 bytes. An empty payload clears the host's slot (a clear when the host has no registered slot gets no PAIR_SLOT_ACK, since there is no slot to name); the host sends it when the offer ends and when it retires the typed code.
  - 5 PAIR_SLOT_ACK (relay to host only, sessionId 0): payload = `status u8` (0 registered, 1 slot taken by another host, 2 malformed) followed by the 3 slot characters. A host that gets status 1 draws a new code and sends PAIR_SLOT again.
  - 6 CREDIT (both ways, only on an uplink that dialed `?credit=1`): payload = u32 LE count of that session's bytes the sender's consumer took since its last CREDIT. See "Session credit".
- The relay assigns sessionIds. Client <-> relay messages are the raw opaque bytes, with no header.
- Pairing budget: at most 10 `GET /v1/pair/<slot>` and 10 pairing sessions (client connections with `?pair=<slot>`) per slot per 10 minutes (429 / 4429 beyond). Ordinary sessions are never charged to a slot.
- Per-source pairing quota: each source IP may make at most 3 `GET /v1/pair/<slot>` lookups and open at most 3 pairing sessions per slot per 10 minutes; a refused lookup gets HTTP 429 and a refused session is closed with 4429, the same responses as the slot budget. The slot's session budget is charged only when the host has answered the session's pairing message (its first DATA on that session); a session the host closes without answering is not charged. A single source therefore cannot drain either budget alone. Many independent sources still can, which denies typed-code pairing for that code but never reveals the secret, so the remedy is the QR/link or a new code. The host's own limit of 10 answered attempts per offer (see "Pairing") holds even against a relay that ignores these budgets.
- Source: the relay takes a connection's source address from the `cf-connecting-ip` request header (Cloudflare sets it; a stand-in must honour it, because the public suites send it to act as distinct sources). The source key is the IPv4 address itself (an IPv4-mapped IPv6 address `::ffff:a.b.c.d` counts as `a.b.c.d`) and the /64 prefix of an IPv6 address, however the address is written, so one IPv6 subscriber cannot mint a fresh bucket per address. An address that does not parse is keyed as given. Every per-source limit and quota above uses this key.
- The relay never decrypts, never logs payloads, enforces a 1 MiB message cap, and forwards immediately with no batching.

### Relay text messages

These four text messages are the only ones allowed on relay sockets (`c:` only toward a client that dialed `?credit=1`); everything else must be binary:

| Message                    | Sender                                                                | Meaning                                                 |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| `ping`                     | client or host, every 30 s                                            | keepalive                                               |
| `pong`                     | the relay, via `setWebSocketAutoResponse` (no Durable Object wake-up) | keepalive reply                                         |
| `a:<total bytes received>` | the receiver of relay traffic (client or host uplink), every 64 KiB   | flow-control acknowledgement                            |
| `c:<bytes>`                | the relay, to a client that dialed `?credit=1`                        | the host consumed this many more of the session's bytes |

- Backpressure: the Durable Object keeps `sent - acked` per socket in its attachment and closes the sending side with 4408 when it exceeds 4 MiB. Acknowledgements are cumulative and must be monotonic: an `a:<n>` that is not a decimal integer, is smaller than the last acknowledgement, or is larger than the bytes actually sent to that socket is a protocol error and closes the socket with 4402, so a peer cannot ack bytes it never received to make the relay buffer without bound.
- Host uplink flow control: the uplink carries every session of the host, so the host acks each frame when it arrives, whether or not that session's reader has taken it. Withholding acks for one slow session would stall the whole uplink and make the relay close it, and with it every other client's session, with 4408. Each session instead bounds its own undelivered bytes: once more than 4 MiB of one session's DATA payload is waiting for its reader (exactly 4 MiB is allowed), the host closes only that session with CLOSE 4408 and drops its later DATA, still acking it. The host therefore buffers at most 4 MiB per session, so at most (32 active + 8 pending) x 4 MiB = 160 MiB per uplink.
- Session credit (v1.4): v1.3.1 keeps one slow session from stalling the uplink, but a sender still cannot see how far behind its peer's reader is, so a bulk transfer (a large `file.write`, a terminal printing fast) reaches a 4 MiB bound and loses the session to 4408: the host's per-session bound one way, the relay's per-socket cap toward the client the other. Credit lets each sender keep within what the far reader has taken. The unit is a session's DATA payload bytes: the bytes a client message carries, and a host DATA frame without its 5-byte header.
  - Opt-in: a host uplink opts in by dialing `/v1/host/<hostId>?credit=1`, a client by dialing `/v1/client/<hostId>?credit=1` (with `&pair=<slot>` when pairing). A relay that serves credit sends a credit uplink a zero CREDIT for each session right after its OPEN; that is how the host learns credit flows on that session. It sends a credit client `c:0` right after accepting it, but only when the host is a credit uplink too.
  - Host to client: the host reports, as CREDIT frames, the DATA payload bytes its reader took, once at least 64 KiB has accumulated. The relay passes the host's credit on to a credit client as `c:<bytes>`, coalesced: it sends one `c:` once at least 64 KiB of credit is pending, or once the host has credited every byte the relay forwarded on that session. A non-credit client gets no `c:` texts.
  - Client to host: the client's `a:<n>` acknowledgements (sent at least every 64 KiB of received bytes) reach a credit uplink as CREDIT for that session, whether or not the client itself asked for credit.
  - The window: a sender that has seen credit start keeps at most 512 KiB of a session in flight, that is, sent and not yet credited. It holds later sends, in order, until credit returns, except that a send always goes while less than 64 KiB is in flight. Up to 64 KiB - 1 bytes may stay uncredited forever (reports come in 64 KiB steps), so a message of any allowed size (up to 1 MiB - 5 bytes) still goes. In-flight data is therefore at most max(512 KiB, 64 KiB - 1 + one message).
  - Errors: a host CREDIT for more bytes than the relay forwarded on that session, or any CREDIT from an uplink that did not dial `?credit=1`, closes the uplink with 4402. A credit client that receives a `c:<n>` for more than it has in flight closes its own socket with 4402. A malformed `c:` text is also 4402; any other text a client does not expect is 1003.
  - Bounds: credit adds no buffer anywhere. The host still acks on arrival and keeps v1.3.1's 4 MiB per-session bound, which a client that ignores its window (or does not opt in) can still reach; a client that honours credit keeps that session's backlog at most max(512 KiB, 64 KiB - 1 + one message). The relay keeps the 4 MiB cap on every socket, credit uplinks included, so the bounds stay 160 MiB per uplink on the host and 4 MiB per socket on the relay.
- Keepalive: an alarm reaps sockets whose auto-response timestamp is more than 90 s old, with 4408.
- Direct path: there is no relay, so the host itself answers each text `ping` with a text `pong`, and closes a `/v1/e2ee` socket with 4408 when it has received nothing (no record and no `ping`) for 90 s. Clients send `ping` every 30 s on the direct path too.

### Standing in for the relay

The suites in `tests/relay` check a relay against this section. They start it with `wrangler dev --ip 127.0.0.1 --port <port> --local-upstream 127.0.0.1:<port> --persist-to <dir>` in the relay's directory (`DORIFACE_RELAY_DIR`), and wait for its `Ready on http://...` line. Timeout tests start another instance with `--var NAME:<milliseconds>` overrides, which a stand-in must accept:

| Variable             | Default | Meaning                                                  |
| -------------------- | ------- | -------------------------------------------------------- |
| `PENDING_TIMEOUT_MS` | 10000   | a pending session's time to the host's first DATA (4408) |
| `IDLE_TIMEOUT_MS`    | 90000   | a socket with no `ping` for this long is reaped (4408)   |
| `AUTH_TIMEOUT_MS`    | 10000   | an uplink's time to answer its challenge (4403)          |

## Direct path

- The host also serves `GET /v1/e2ee` (WebSocket) on its LAN listener, speaking the same record layer without the relay header. Because every byte is authenticated, this endpoint may bind non-loopback. The plaintext `/v1/hc` stays loopback-only. It accepts session kinds `0x01` and `0x03`; it closes kind `0x02` (typed-code pairing, which needs the relay's budget) with 4401 without answering.
- Clients try direct (when a LAN URL is known and reachable within 300 ms) and the relay in parallel. The relay is the default; once a direct session's handshake completes, it is preferred. The session swap reattaches terminals with `resumed: true`.

## Mesh

A mesh is a set of hosts that trust each other fully: a host admitted by any member is reached by every member, and each member's core adds every other member as a herdr machine on its own. Mesh traffic is ordinary sessions between hosts; the relay stores nothing and needs no mesh-specific behaviour.

### Records

- A mesh is a grow-only set of records `{body, sig}`. `body` is an I-JSON (RFC 7493) object of at most 2048 bytes, signed and hashed as the exact bytes its signer produced; its hash is base64url (no padding) of SHA-256(body).
- Body: `v` (2), `mesh` (the mesh id; `"-"` only in the founding record), `type` (`found`, `admit`, `revoke`, `name`, `rekey`, `ack`), `by` (the signer's signPub), `n` (the signer's counter: 1 for its first record; every other record of the signer has the signer's record `n - 1` in its past and no record of the signer with a counter of `n` or more), `prev` (1 to 64 hashes of the signer's heads; empty only in `found`), `subject`, and optionally `at` (display only). `found`, `admit` and `rekey` embed a member card; `revoke` names 1 to 16 distinct signPubs; `name` names a member and a mesh name.
- A member card is `{body, sig}` signed by its subject: `{"v":1,"mesh","inviter","nonce","hostId","signPub","noisePub","devicePub"?,"name","hcId"}`. In an `admit`, the card names this mesh and the admitting member; in a `rekey`, the signer's own new Noise key. A card's nonce admits once.
- A host stores a record only if it is well formed and verifies, its card verifies under its subject and matches the record, its signer is a key the set admits, and it belongs to this mesh. A record whose past is incomplete waits (at most 256); a mesh holds at most 4096 records.
- On merging an `admit`, `revoke` or `rekey` signed by another member, a member signs an `ack` (prev = its heads) in the same step.

### Membership

The view of a record set is computed by the algorithm below. It reads only views of strictly smaller sets and the order of the records, so every set has exactly one view, whatever order its records arrived in. No clock takes part.

Notation. The input S is a past-closed record set containing exactly one `found` F. `past(x)` is every record reachable from x through `prev`. `a ∥ b` (concurrent) means neither is in the other's past. The canonical order is Kahn's topological order of S, smallest hash first among ready records. `view(T)` is this algorithm applied to the past-closed set T, and `members(V)` and `revoked(V)` are its member and revoked sets. `M(x)` = `members(view(past(x)))`. `gov(k in V)` is k's governing admission in view V. `pred(x)` is the signer's record with counter `x.n - 1` in `past(x)`; where the signer merged its own fork and `past(x)` holds more than one, `valid(pred(x))` holds only if every one of them is valid. A `lineage` walk that comes back to a key it already passed never reaches a stop: it is not clean (`clean0` is false), it does not silence, and it excludes no voter. Comments that mention "revision 2" are informative: they name the draft rule a line was carried over from.

```
# Structure (revision 2, plus one line)
valid(x)        = x.by ∈ M(x) and type_ok(x) and own_chain(x)
                  and (x.n == 1 or valid(pred(x)))                       # the own chain is a chain of VALID records
C(v, x)         = past(v) ∩ past(x);   CM(v, x) = members(view(C(v, x)))  # the common past and its members
lineage(k, V, C) = the admissions on k's admitter chain in view V that lie outside C
                  (stop at a member of view(C), at an admission inside C, or at the found record)

# Level 0: every structurally valid concurrent revoke accuses (revision 2's accusers)
accusers0(x)    = { v ∈ S : v.type == revoke, x.by ∈ v.subjects, v ∥ x, valid(v) }
voters(v, x)    = CM(v, x) \ {x.by, v.by}
                  \ { g.by : g ∈ lineage(x.by, view(past(x)), C) ∪ lineage(v.by, view(past(v)), C) }
                  # the common past only (nobody can pad it); neither party, nor whoever admitted either party
                  # after the fork (the minter of v.by is a voter in name only: P13)
silences0(r, w) = r.by ∉ revoked(view(past(w))) and accusers0(r) = ∅
                  and ∀ g ∈ lineage(r.by, view(past(r)), C(r, w)): accusers0(g) = ∅   # the WHOLE lineage (P3)
testifies0(w)   = valid(w) and ¬∃ r ∈ accusers0(w): silences0(r, w)
support0, saw0  = as revision 2, with testifies0
defeats0(v, x)  = forks(v, x) or support0(v, x) > support0(x, v)

# Standing: a revoke may accuse only if its signer's provenance survives level 0
clean0(r, C)    = ∀ g ∈ lineage(r.by, view(past(r)), C): ¬∃ u ∈ accusers0(g): defeats0(u, g)
standing(v, x)  = clean0(v, C(v, x)) and ¬∃ u ∈ accusers0(v): clean0(u, C(u, v)) and defeats0(u, v)

# Level 1: what the view uses
accusers(x)     = { v ∈ accusers0(x) : standing(v, x) }
voters1(v, x)   = voters(v, x) \ v.subjects                              # a batch's mates do not vote on the batch
silences(r, w)  = accusers(r) = ∅ and ∀ g ∈ lineage(r.by, view(past(r)), C(r, w)): accusers(g) = ∅
                  # no "r.by already revoked in past(w)" escape: the attacker makes that true itself
testifies(w)    = valid(w) and ¬∃ r ∈ accusers(w): silences(r, w)
verdict(v, x)   = defeated  if forks(v, x) or support(v, x) > support(x, v)
                = tie       if x.type ≠ revoke and support(v, x) = support(x, v) = 0     # fail closed
                = stands    otherwise
own(x)          = invalid if ¬valid(x); defeated if ∃ v ∈ accusers(x): verdict(v, x) = defeated;
                  tie if ∃ v: verdict(v, x) = tie; else clear

status(x), in canonical order:
  found                         → eff
  own(x) ∈ {invalid, defeated}  → void
  x.type == revoke              → void unless every g ∈ lineage(x.by, view(past(x)), ∅) has own(g) ∈ {clear, tie}
                                  # a revocation survives uncertainty on its lineage; a defeated lineage voids it
  otherwise                     → void unless status(gov(x.by in view(past(x)))) == eff
  else                          → tie if own(x) == tie, else eff
eff = { x : status(x) == eff };  return membership(S, eff)                 # membership() as revision 2

# Unchanged from revision 2
forks(v, x)     = some counter n names one record of x.by in {x} ∪ past(x) and another in past(v)
own_chain(x)    = every record of x.by in past(x) has a counter < x.n, and x.n - 1 is one of them (x.n = 1: none)
saw(p, a, b)    = ∃ w ∈ S, w.by == p, a ∈ past(w), b ∉ past(w), testifies(w)       # saw0: with testifies0
support(a, b)   = |{ p ∈ pool : saw(p, a, b) and not saw(p, b, a) }|
                  # pool = voters1(v, x) of the conflict at level 1, voters(v, x) at level 0 (same pool both ways)
type_ok(x, V)   = admit:  subject ∉ V.members, or the card's noisePub == V.noise[subject]
                  name:   subject ∈ V.members
                  rekey:  by == subject
                  revoke: every subject is the subject of some found/admit in past(x)
                  ack:    true

membership(S, eff):
  for each key k admitted in S:
    gov(k) = the first record in canonical order among eff found/admit of k
             that has every eff revoke of k in its past              # re-admission follows every revoke
  members  = keys with a gov, ordered by the canonical position of gov; the first 12 are members,
             the rest are over-cap (not dialed, cannot sign; M5)
  revoked  = keys with no gov and at least one eff revoke
  noise[k] = the card of the latest eff rekey by k with gov(k) in its past, else gov(k)'s card
             (latest = no other such record in its future; ties: smallest hash)
  name[k]  = the latest eff name about k with gov(k) in its past, else gov(k)'s card name;
             then, in member order, a name already taken gets the section 7.4 fallback
  admitter[k] = gov(k).by                             # lineage (H2)
```

- Both directions of one conflict use the same pool, the voters of (accuser v, accused x): `voters` at level 0 and `voters1` at level 1. The revoke lineage walk in `status` is taken hop by hop: it starts at the governing admission of the revoke's signer in `view(past(x))`, and each later hop looks up the governing admission of the previous admission's signer in the view of that admission's own past (`view(past(g))`, the view it was written under), not in one fixed view. A key with no governing admission on the way voids the revoke, and the walk goes all the way to the founding record.
- A conflict that no independent member present at the revoked key's last own record can decide is resolved fail-closed: the revoked key's admits and other non-revokes fall, and its revokes stand.
- A member's Noise key comes from its admission's card or a later `rekey` it signed; an admit never changes a current member's key. A member's governing admission is the first effective one, in canonical order, that follows every effective revoke of it. Its admitter is that admission's signer (the lineage). At most 12 members: members past the twelfth in canonical order are over-cap, are not dialed and cannot sign.

### Joining, sync and connectivity

- `doriface-host mesh join <url|code>` runs the pairing handshake as the client with the host's own Noise key and `stream:"mesh"`; the member sends `{"t":"offer","mesh","inviter","nonce"}`, the joiner answers `{"t":"card",...}`, the member admits after approval and sends the whole set as `records` lines of at most 256 KiB and a final `{"t":"done","mesh"}`. A host that is already a member with the same Noise key gets the welcome only, from any member; with another Noise key it is refused. The joiner checks the founding record against the mesh id, that the member it dialed is in the view with the key it authenticated, and that it is itself a member of the view with its current Noise key (whoever admitted it), before it stores anything.
- Sync sessions (`0x01`, `stream:"mesh"`) are opened on demand (to push, after this host's own outage, and every 10 minutes as a safety net) and closed after 60 s idle. Lines: `hello` (heads and counters), `want`, `records`, `done`; at most 256 KiB each. Each side answers every `hello` with the records the hello's heads lack and a `done`, even when it sends no records. After saying `hello`, a side closes the session with 4400 when 30 s pass without a `records` or `done` line from the peer; an answer that keeps delivering is never cut.
- Every mesh stream line is one UTF-8 JSON object with a string member `t`, terminated by LF and at most 256 KiB including the LF. A receiver ignores a line whose `t` it does not know. A line that is longer, is not a JSON object with a string `t`, or lacks a member its known `t` requires closes the session with 4400, and so does a line of a known `t` that the receiver's step does not take (during a join, the member takes only `card`, then `refused`; the joiner only `offer` or `refused`, then `records`, `done` or `refused`) and a reader more than 256 lines or 4 MiB behind. A joiner closes with 4400 a welcome of more than 4096 records or more than 8 MiB of record bytes. A host that refuses a join, a member card or a mesh stream from another mesh first sends `{"t":"refused","reason":"<text>"}` (the reason is for display only) and then closes with 4401.
- Every member's core adds every other member with `machine.add --via '<doriface-host> connect --mesh --state-dir <dir> <hostId>'`; the running host dials each such line with its own Noise key. A host keeps `machine.list` equal to the view and handles herdr's `name_taken` with the fallback names `<name cut to 31-k>-<first k hostId characters>`, k = 4, 8, 12.
- Dialing: a host starts at most 12 relay upgrades per 60 s for the mesh (sessions on the direct path are not counted), does not redial a member that answered 4404 until that member shows presence (any authenticated session from it) or a probe is due (30 s doubling to 5 minutes), jitters additions and presence dials, and after its own uplink returns waits 10-20 s before dialing members that have not shown presence. A 4429 halves the budget for 10 minutes. This keeps four co-located hosts within the relay's per-address connection limit, with room left for clients.

### Revocation

- `doriface-host mesh revoke <member>` signs a `revoke`; `--compromised` names the member and everyone it admitted, transitively, in one record. Every member closes the revoked keys' sessions (4401): inbound ones at once, and a sync session it dialed to a revoked member within 60 s, so the revoked host still learns its revoke and the acks after it. It removes the machine, removes the keys from its paired-devices store and the hostId from its known hosts, and refuses those keys on every path. `mesh leave` signs a revoke of the leaving host first. A host acts on its own revocation only when its computed view says so, and stays read-only for 7 days.
- Compromise of any member's keys, of a device paired to any member, or of an open offer is compromise of the mesh until revoked; the records name who did what.

### Host state and commands

- `mesh.json` (in the host's state directory, readable only by its owner) holds the stored records, the dangling pool (at most 256 records whose past or whose signer's admission has not arrived; the oldest is dropped first), a `generation` incremented on every write, and the host's own counter `self.n`. The counter is written before a record is signed with the next number, and a host signs nothing of its own, its automatic acks, the `admit` of a join it approves (`mesh pair`, `mesh approve`) and the operator's `mesh rename`, `mesh revoke` and `mesh leave` included, while a higher counter of its own key appears in its records or is claimed in a peer's `hello`; such a command, or the join, is refused with the claiming peer, the claimed counter and this host's own (the joiner gets `refused` and 4401), and signs when run again once those records arrived or the claim lapsed. Its own records that arrive move `self.n` up to them in the same merge. Such a claim belongs to the peer, not to the session: it ends when the host holds its own records up to the claimed counter, and it lapses 30 s after the claim unless that peer delivers more of them, each delivery starting the 30 s again. Ending, replacing or re-greeting the session does not end or renew it, and neither does a `done`, records the host signs itself, or its own records delivered by another member. When a claim lapses, that peer's claims are ignored for 10 minutes; an automatic ack held back by a claim is signed once no claim stands. An answer to a `hello` sends the hello sender's own records first, in lines of their own with their past, so an honest claimer's first line already moves its claim. A claim also makes the peer owe a `done`, so 30 s without a non-empty `records` line or `done` closes the session with 4400. The 30 s is a safety net with a stated trade-off: a restored host whose next missing own record takes longer than 30 s to arrive from the claimer (a long past ahead of it, or one 256 KiB line on a link below about 9 kB/s) stops waiting and may then sign a record that forks its own chain; a longer limit would let a hostile member hold back this host's signing, and with it a `mesh revoke` of that member, for longer. Trust comes from the records alone; every other field is a cache or display state.
- `line.sock` is a Unix socket (0600) in the host's state directory. `doriface-host connect --mesh <hostId>` connects to it and sends `{"v":1,"hostId":"<hostId>"}`; the running host answers `{"ok":true}` and dials that member with its own Noise key, or `{"ok":false,"code":<close code>,"reason":"..."}` when the hostId is not a current member within the cap or the dialing rules hold the dial back. After `ok` the connection is a byte pipe to the member's hc line.
- `doriface-host mesh status [--json]` shows, from this host's view, each member's name, hostId, Noise fingerprint, admitter and line state, the over-cap and revoked keys, the new-member notices, pending joins awaiting approval, each member's revoke-time witness pool, and the sync state.
- `doriface-host mesh rename <member> <name>` signs a `name` record about a current member. The name follows the mesh-name rule above; when two members end up with the same name, the later one in member order takes the first free fallback name.
- New-member notice: for 7 days after it merges a member's admission, every member shows "`<name>` joined via `<inviting member>`, admitted by `<admitter>`, fingerprint `<fingerprint>`" in `mesh status` and in its `doriface-mesh` herdr document, so an admission written with a compromised member's key is visible on every member.

### What the relay learns from a mesh

- Which hostIds open sessions to which, from which addresses, and when; not the records, names or rules, and nothing it can forge, replay or splice.

## Close codes

- 4400: crypto failure, including an unknown session kind, a malformed first message, an invalid CPace share, or a key confirmation that does not decrypt; an unknown or misplaced `stream`, early bytes on a mesh session, a malformed or oversize mesh stream line, a sync peer that sends no `records` or `done` line for 30 s after a `hello`, a mesh name that breaks the mesh-name rule, or an hc line before the framed `hello` that breaks the rule under Session kinds
- 1011: the host failed internally (for example it could not record a typed-code attempt); nothing was answered
- 4401: unknown device, or a pairing the host does not accept here: no live offer, an offer already used, a typed-code pairing on the direct path or without `?pair`, a slot that is not the offer's, or a session kind `0x01` on a `?pair` session; a device pairing on a mesh offer or a join on a device offer, a mesh stream from another mesh, a refused member card, a revoked mesh member, or an hc `hello` whose `core.id` does not match
- 4402: relay protocol error (for example an invalid `a:<n>` acknowledgement, credit for bytes never sent, or a malformed `c:`)
- 4403: relay auth failed
- 4404: host offline
- 4408: idle or backpressure timeout, a handshake that did not finish within 10 s, or a relay session whose undelivered bytes on the host exceeded 4 MiB
- 4409: uplink replaced by a newer authenticated uplink for this hostId; the replaced host must not reconnect
- 4410: pairing slot not registered to this host (expired, retired or never opened)
- 4429: rate limited, including a typed code whose 10 answered attempts are spent

## Change log

- v1.5: a machine mesh over the relay with no relay change. Membership is a grow-only set of signed, hash-linked, per-signer-chained records (`found`, `admit`, `revoke`, `name`, `rekey`, `ack`) whose admissions embed the subject's self-signed card; the view is a total function of the set (rule R3, two levels), conflicts between a record and a concurrent revoke of its signer are decided by the signed testimony (automatic acks) of the members of their common past who are neither party nor a party's post-fork admitter, only revokes with standing may accuse, an undecidable conflict fails closed, and every set has exactly one view. A host joins through the existing pairing flow against one member, with that member's fingerprint confirmation, and is then trusted by every member, which shows a new-member notice. Gossip runs over on-demand sync sessions; each core adds every other member through `doriface-host connect --mesh`, dialed by the host with its own key, under a per-host dial budget sized for the relay's per-address limit. Revocation from any member, including `--compromised` subtree revocation, closes sessions with 4401 and removes the member from every paired-devices store. New: the `stream` payload member, `&m=1`, the mesh stream lines, `mesh.json`, `line.sock`, the 12-member cap and the `mesh pair|join|status|revoke|rename|leave` commands.
- v1.4 (documentation, no wire change): the relay section now states rules the relay already enforced and the public suites check, so another server can stand in: the per-source rates (60 upgrades, 20 lookups per minute), the `cf-connecting-ip` source and its IPv4 / IPv6 /64 key, the 4404 for a replaced uplink's sessions, no PAIR_SLOT_ACK for a clear without a slot, and the test-only timeout variables.
- v1.4: end-to-end session credit on top of v1.3.1: the `?credit=1` opt-in, the CREDIT mux frame (type 6) and the relay's coalesced `c:<bytes>` text, with a 512 KiB per-session window that always lets a send go below one 64 KiB credit step. The host still acks the uplink on arrival and keeps the 4 MiB per-session bound and its 4408; credit only keeps a cooperating client below that bound, so the 160 MiB per-uplink and 4 MiB per-socket bounds are unchanged. Peers without the opt-in keep v1.3.1 exactly.
- v1.3.1: the host uplink acks each relay frame on arrival and bounds each session's undelivered bytes at 4 MiB, closing only that session with 4408 (at most 160 MiB per uplink); acks no longer wait for a session's reader, so one slow session cannot stall the uplink.
- v1.3: typed-code pairing uses CPace (CPACE-RISTR255-SHA512, draft-irtf-cfrg-cpace-21) bound to hostId, the host Noise static key, the slot and a per-attempt session id; its key is the IKpsk2 psk, so every code guess costs one answer from the real host and no relay or observer can test a guess offline (v1.2 let one message 2 test every code). The pairing URL carries a 32-byte link secret (`p=`) instead of the code. Every session's first message starts with a kind byte (`0x01` session, `0x02` pair-code, `0x03` pair-link), bound into the prologue. The host retires a typed code after 10 answered attempts per offer and refuses typed-code pairing on the direct path. The handshake payload rules (`"v":1`, the message 2 `lan` reply, the 256-byte line, the 64-unit name and the 4096-byte early data) and the empty key-confirmation record are now written down. v1.2 pairing and session messages are refused.
- v1.2.1: close code 4409 (uplink replaced), which the relay already sends when a newer uplink authenticates for the same hostId.
- v1.2: pending-session admission; the `a:<n>` backpressure acknowledgement; the relay origin in the uplink signature; non-extractable device keys with a raw fallback; `ping`/`pong` keepalive; the pairing budget moved to the relay, with codes burned only on success or expiry (replacing "burn after 3 failed handshakes"); PAIR_SLOT carrying the Noise static key, acknowledged by PAIR_SLOT_ACK; pairing sessions marked with `?pair=<slot>`; monotonic acknowledgements, rejected with 4402 when out of range; per-source quotas on pairing lookups and sessions, with the slot's session budget charged only after the host answers; close codes 4402 and 4410; direct-path keepalive; pinned prologue, payload and nonce rules. Resume without a repaint is deferred.
- v1.1: the 8-character typed code with a relay pairing slot; the SHA-256 hex fingerprint; the `doriface-host pair` and `doriface-host fingerprint` command names.
- v1: initial contract.
