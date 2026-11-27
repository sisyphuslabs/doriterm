/**
 * The Ed25519 keys a Doriterm release is signed with (#1969), base64 of the 32 raw public-key bytes. The release's
 * mirror signs SHA256SUMS.txt and each channel's host manifest with the private half, a GitHub environment secret; the
 * host binary checks a manifest against these before it downloads anything, and install.sh asks the binary it just
 * fetched to check SHA256SUMS.txt. Rotation: a release signed by the old key ships a build that trusts both keys, and
 * the next release is signed with the new key only.
 *
 * Its own module so that only the desktop e2e build can swap it (apps/desktop/scripts/build.ts, #2945); every shipped
 * build carries exactly these keys, which apps/desktop/test/release-keys.test.ts checks in the production bundle.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = ["gyHmvVxtAxI8+BK2tzpS9fotce5Tx9/KUiAVgEWp7LY="];
