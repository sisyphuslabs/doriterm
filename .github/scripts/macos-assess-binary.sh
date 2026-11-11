#!/usr/bin/env bash
# Fails unless a bare Mach-O binary carries a valid Developer ID Application signature under the hardened runtime and
# Gatekeeper accepts it as notarized (#1992).
#
# Usage: macos-assess-binary.sh <binary>
#
# spctl's execute type assesses app bundles only: it rejects every bare binary, notarized or not, with "the code is
# valid but does not seem to be an app". The install type assesses a downloaded tool. A bare binary cannot carry a
# stapled ticket, so spctl looks the ticket up online, which can lag notarytool's Accepted; that lookup is retried.
set -euo pipefail

binary="${1:?usage: macos-assess-binary.sh <binary>}"
name=$(basename "$binary")
fail() {
  echo "::error title=Gatekeeper::$1"
  exit 1
}
[ -f "$binary" ] || fail "$binary does not exist"

codesign --verify --strict --verbose=2 "$binary" || fail "$name has no valid signature"
details=$(codesign -dvv "$binary" 2>&1) || fail "codesign could not read the signature of $name"
echo "$details"
grep -q '^Authority=Developer ID Application: ' <<<"$details" ||
  fail "$name is not signed with a Developer ID Application certificate (an ad-hoc signature has no Authority)"
grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$details" ||
  fail "$name is not signed with the hardened runtime, which notarization requires"

for attempt in $(seq 1 10); do
  verdict=$(spctl --assess -vv --type install "$binary" 2>&1) && accepted=1 || accepted=0
  echo "$verdict"
  if [ "$accepted" -eq 1 ] && grep -q 'source=Notarized Developer ID' <<<"$verdict"; then
    exit 0
  fi
  echo "spctl did not accept $name as notarized (attempt $attempt of 10), retrying in 30s"
  sleep 30
done
fail "Gatekeeper does not accept $name as a notarized Developer ID binary"
