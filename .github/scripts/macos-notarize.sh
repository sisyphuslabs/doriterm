#!/usr/bin/env bash
# Notarizes a Developer ID signed .app, .dmg or bare Mach-O binary with an App Store Connect API key, then staples the
# ticket to an app or a dmg. A bare binary cannot carry a ticket: Gatekeeper looks it up online.
#
# Usage: macos-notarize.sh <path to .app, .dmg or binary>
# Env:   APPLE_API_KEY (path to the AuthKey .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER,
#        NOTARIZE_TIMEOUT_SECONDS (optional, default 2700).
#
# It submits without `notarytool --wait` and polls `notarytool info` itself, so a network error while Apple is still
# working retries instead of failing a build whose submission is fine.
set -euo pipefail

target="${1:?usage: macos-notarize.sh <path to .app, .dmg or binary>}"
fail() {
  echo "::error title=Notarization::$1"
  exit 1
}

for name in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
[ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY must be the path to the .p8 key file"
[ -e "$target" ] || fail "$target does not exist"

notary=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
name=$(basename "$target")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

staple=1
case "$target" in
  *.app)
    # notarytool takes an app as a zip; the ticket is stapled to the app itself afterwards.
    upload="$work/${name%.app}.zip"
    ditto -c -k --keepParent "$target" "$upload"
    ;;
  *.dmg) upload="$target" ;;
  *)
    # notarytool takes a bare binary as a zip too, and nothing can be stapled to it (#1992).
    file -b "$target" | grep -q '^Mach-O' || fail "expected a .app, a .dmg or a Mach-O binary, got $target"
    upload="$work/$name.zip"
    ditto -c -k --keepParent "$target" "$upload"
    staple=0
    ;;
esac

submitted=$(xcrun notarytool submit "$upload" "${notary[@]}" --output-format json)
id=$(jq -r '.id // empty' <<<"$submitted")
[ -n "$id" ] || fail "notarytool returned no submission id for $name: $submitted"
echo "Submitted $name for notarization as $id"

deadline=$(($(date +%s) + ${NOTARIZE_TIMEOUT_SECONDS:-2700}))
while :; do
  status=""
  if info=$(xcrun notarytool info "$id" "${notary[@]}" --output-format json 2>&1); then
    status=$(jq -r '.status // empty' <<<"$info")
  else
    echo "notarytool info failed, retrying: $info"
  fi
  case "$status" in
    Accepted) break ;;
    Invalid | Rejected)
      xcrun notarytool log "$id" "${notary[@]}" || true
      fail "Apple answered $status for $name ($id)"
      ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "$name ($id) was still ${status:-unknown} at the deadline"
  echo "$name: ${status:-unknown}"
  # Apple has no callback for a submission, so this waits between polls.
  sleep 20
done
echo "Notarization accepted for $name"
if [ "$staple" -eq 0 ]; then
  echo "$name is a bare binary, which cannot be stapled; Gatekeeper fetches its ticket from Apple online"
  exit 0
fi

stapler="$(dirname "$0")/macos-stapler.sh"
bash "$stapler" staple "$target" || fail "could not staple the notarization ticket to $name ($id)"
bash "$stapler" validate "$target" || fail "the stapled ticket on $name ($id) does not validate"
