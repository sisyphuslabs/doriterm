# Releasing and the download host

Doriterm publishes every release on GitHub Releases and serves it from `get.doriterm.com` (#1969). GitHub Releases
stays the source of truth: the mirror copies a published release into a private R2 bucket, and the Worker in
`apps/get` answers from that bucket, falling back to GitHub for any file that is not there.

## What a tag does

`release.yml` builds a `vX.Y.Z` tag into a draft, smoke-tests the draft on Linux, macOS and Windows, publishes it, and
then runs the `Mirror to get.doriterm.com` job:

1. Download every file of the release and check each against `SHA256SUMS.txt` and GitHub's own digest.
2. Sign `SHA256SUMS.txt` with the release key (Ed25519), refusing a key the shipped builds do not trust
   (`RELEASE_PUBLIC_KEYS` in `packages/crypto/src/release.ts`), and attach `SHA256SUMS.txt.sig` to the release.
3. Upload each file to `releases/v<version>/` with its SHA-256 as the signed payload hash. An object is created once; a
   re-run accepts the identical object and refuses a different one.
4. Read every object back and hash it again.
5. Write `releases/v<version>/.complete`, the hash and size of every file.
6. Move `channels/<channel>.json` with `If-Match`, only over the pointer read before and never to a version older than
   the one it offers (a backport needs `release-channel.yml`).
7. Write the channel's host manifest and its signature, then wait until `/dl/host-linux-x64` names the new version.

A tag with a prerelease suffix (`v0.2.0-rc.1`) goes to the `beta` channel, any other to `stable`; beta also offers
stable when stable is newer. The repository variable `RELEASE_ROLLOUT_PERCENT` sets the first rollout (default 100) and
`RELEASE_MINIMUM_VERSION` the lowest version that can update itself to this one.

A failure anywhere leaves the previous pointer in place: get.doriterm.com keeps offering the previous version,
`/v/<new version>/` redirects to GitHub, and the GitHub release stays published. Re-run the job once the cause is fixed.

A manual dispatch of `release.yml` from `dev` builds a draft and mirrors it into the staging bucket behind
`staging.get.doriterm.com`, so the whole path can be tried without publishing anything (from another branch it builds
the draft and skips the mirror, since the staging environment holds the real signing key). Builds are not byte for byte
reproducible and a mirrored file is never replaced, so a second dispatch of the same version fails against the staging
bucket: try again with a new prerelease version, or empty that version's folder in the staging bucket first.

## Mirroring a release by hand

Both mirrors run the one job in `release-mirror.yml`. Run it by hand (Actions, Run workflow, on `dev`) with a tag and a
target (`staging` or `production`) to mirror a release that is already published, such as one published before the
mirror existed, or to finish a mirror whose run failed. It refuses a tag that is not a published release; a re-run
accepts the objects an earlier run left and moves the channel only forward. Mirror to `staging` first and read
`https://staging.get.doriterm.com/desktop/<channel>/latest-mac.yml` back before `production`.

## Moving a channel

`release-channel.yml` (Actions, Run workflow, on `dev`) takes a target (`staging` or `production`), a channel and one of:

| Operation                     | Effect                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `head`                        | Prints the pointer.                                                                               |
| `promote <version> <percent>` | Sets the rollout of the version the channel offers; 0 pauses it.                                  |
| `rollback <version>`          | Points the channel at the version before, only while it still offers `<version>`.                 |
| `yank <version>`              | No feed, manifest or `/dl` link names the version again; `/v/<version>/` keeps serving its files. |

Within a minute of a rollback or a yank the desktop feeds, the host manifest and every `/dl` link name the version
before, so no further install receives the bad one. Installs that already updated stay on it: neither the desktop app nor
the host downgrades, so the remedy for them is the next release.

## Staged rollout

The pointer's `rollout` is the percentage of installs offered the version. The desktop app reads it as
`stagingPercentage` in its feed, and electron-updater compares it with a random id it keeps in its own data folder; the
host compares it with the id in `<state dir>/updater-id`. Neither id ever leaves the machine.

## Secrets

The `release-mirror` and `release-mirror-staging` environments hold `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
(an R2 token scoped to the one bucket), `CLOUDFLARE_ACCOUNT_ID` and `RELEASE_SIGNING_KEY` (base64 of the 32-byte
Ed25519 seed). Both environments hold the real signing key (the mirror refuses a key the builds do not trust), so both
must allow deployments from `dev` and release tags only, in the environment's deployment branch rules. Rotating the
release key: ship a release whose `RELEASE_PUBLIC_KEYS` lists the old and the new key, signed
with the old one; sign the next release with the new key only.

## Download counts

`https://get.doriterm.com/stats/downloads` reports the downloads and update checks counted by the Worker, rolled up
hourly. Each count records what was fetched, through which route, from where it was served, the channel, version,
platform and country; never an address, a user agent, a cookie or an install id.
