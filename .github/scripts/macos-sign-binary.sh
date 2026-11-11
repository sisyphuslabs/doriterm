#!/usr/bin/env bash
# Signs a bare Mach-O binary with the release's Developer ID Application certificate, under the hardened runtime and with
# the given entitlements. electron-builder signs only what it packages, from a keychain of its own, so a binary shipped
# outside the app (the standalone host install.sh downloads, #1992) is signed here.
#
# Usage: macos-sign-binary.sh <binary> <entitlements plist>
# Env:   CSC_LINK (the base64 .p12 certificate), CSC_KEY_PASSWORD.
#
# The certificate goes into a throwaway keychain with a random password; the keychain is deleted and the user's keychain
# search list restored on exit.
set -euo pipefail

usage="usage: macos-sign-binary.sh <binary> <entitlements plist>"
binary="${1:?$usage}"
entitlements="${2:?$usage}"
fail() {
  echo "::error title=Code signing::$1"
  exit 1
}

for name in CSC_LINK CSC_KEY_PASSWORD; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
[ -f "$binary" ] || fail "$binary does not exist"
[ -f "$entitlements" ] || fail "$entitlements does not exist"

work=$(mktemp -d)
keychain="$work/signing.keychain-db"
searched=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#\"}"
  line="${line%\"}"
  [ -z "$line" ] || searched+=("$line")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s ${searched[@]+"${searched[@]}"} >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

password=$(openssl rand -hex 24)
printf '%s' "$CSC_LINK" | tr -d '[:space:]' | base64 --decode > "$work/certificate.p12" ||
  fail "CSC_LINK is not a base64 .p12 certificate"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -f pkcs12 -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null ||
  fail "could not import the certificate in CSC_LINK with CSC_KEY_PASSWORD"
rm -f "$work/certificate.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
# codesign finds the private key only through the search list.
security list-keychains -d user -s "$keychain" ${searched[@]+"${searched[@]}"}

identities=$(security find-identity -v -p codesigning "$keychain" | grep '"Developer ID Application: ' || true)
count=$(grep -c . <<<"$identities" || true)
[ "$count" -eq 1 ] || fail "expected one Developer ID Application identity in CSC_LINK, found $count"
identity=$(awk '{ print $2 }' <<<"$identities")
echo "Signing $(basename "$binary") as $(sed -E 's/^[^"]*"(.*)"$/\1/' <<<"$identities")"

codesign --force --timestamp --options runtime --entitlements "$entitlements" --keychain "$keychain" \
  --sign "$identity" "$binary"
codesign --verify --strict --verbose=2 "$binary"
