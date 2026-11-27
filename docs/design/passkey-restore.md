# Home Screen passkey restore

The [revision 6 review](https://github.com/sisyphuslabs/doriterm/issues/2898) is the authority for this protocol.

1. Set up restore only in a WebKit app whose device and card private keys are already raw in local storage. Create a new
   discoverable credential for the exact app hostname, with a random user handle and a dated display name. Both PRF and
   `largeBlob` must work. Neither the device key nor the vault key is wrapped.
2. After storage loss, the first user-verification assertion evaluates the fixed-salt PRF and reads the encrypted
   `largeBlob` locator. The client fetches an encrypted card seed from a saved holder over Noise NK and signs a fresh
   holder challenge to read the roster. It verifies and merges the signed roster before selecting a current holder.
3. Generate fresh device and card keys. Sign one readmission request with both card keys and submit it over the anonymous
   endpoint. If the old app is live, ask it first. If the view lists any other client member, one of those members must
   compare the short code and sign approval; the holder must wait even if all of them are offline. If the old app is
   not live and is the sole client member, readmission can be unattended. Waiting or denial never waives approval.
4. A machine signs a single `readmit` record. Identical replacements count as one. Only distinct, concurrent, valid
   replacements of the same old identity conflict; neither successor is admitted. Concurrent revoke or compromised wins.
   Other members see the readmission and time. The old identity cannot start a device session.
5. Only after checking the admission does the browser use the new Noise key. The second user-verification assertion
   writes the next locator. If the user declines it, the new membership remains and Settings shows that restore is off.

Each holder keeps the latest encrypted envelope bound to the owner's current signing and Noise keys. The authenticated
owner can remove it. A mesh revoke, supersession, or leave purges it as that update reaches each holder. Holders can
correlate records using the owner keys they already know; the holder-specific lookup ids add no stable correlator. The
relay can see what holders a restore touched, but does not get a stable credential id, lookup id, blob or roster.

If a provider account could be compromised, remove the old passkey in the provider account and revoke the old mesh
member. Use a new invite to regain access and create a new credential when setting up restore again. A stolen card seed
cannot start a session, but a person with access to the passkey and locator can attempt readmission; the sole-client
unattended case still applies. Backing up the vault key is outside this protocol.

## Without a key restore (S2, M14)

When the passkey has no `largeBlob`, or a holder answers `invite` (an older member that cannot read or approve a
`readmit`, M12), there is no key restore. The fallback is the existing one: a member invites the new device, and a
member removes the old one with the existing revoke. Holders never publish the attended form (ii) of `readmit` (no
`oldSig`); the view keeps M14's rule for it (valid only when approved by a current client other than `old`, and
never by a machine key or by `old` itself), so a record of that form from any source is checked the same way. This
keeps one invariant for every `readmit` a holder writes: it carries `oldSig`.

## Relay rollout gate

The client requires `/v1/restore/<hostId>` rather than an ordinary member socket. The relay must independently
enforce 5 requests per minute and 30 per day per source before forwarding a restore `OPEN` frame (payload `01`).
The holder separately budgets lookup ids and all anonymous handshakes. Never forward the source address or lookup
id to logs, and never accept a client-provided route marker as the relay's `OPEN` marker. Normal and pairing sockets
must not reach this endpoint.

Before claiming support, verify on physical iOS devices that the intended provider syncs the discoverable credential
and up-to-eight-holder `largeBlob` across devices. The Chromium fixture tests the protocol with simulated credential
extension results; it does not verify iCloud Keychain.
