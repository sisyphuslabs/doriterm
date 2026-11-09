#!/usr/bin/env bash
# The system packages Playwright's Chromium needs on an Ubuntu runner, installed from a cache of their .deb files when
# that cache provably covers them, and from the apt mirror otherwise.
# Usage: playwright-linux-deps.sh <deb cache dir>, from apps/web (where bunx finds this repository's Playwright), with the
# directory restored by actions/cache. Writes save-debs=true to $GITHUB_OUTPUT when it put a new cache set in the deb cache
# directory: an empty cache it filled, or a stale or partial one it completed from the mirror.
#
# doriterm#1012: on the ubuntu-24.04 image Chromium is missing nine font packages, 21.1 MB, and the Azure mirror has
# served them at about 38 kB/s - nothing stalls, so neither retries nor an http timeout help, and the download outlasts
# its time limit. They come from the frozen release pocket, so for one Playwright version (which decides the list) and
# one distribution (which decides the files) the same .deb files are downloaded every time; the cache key holds both,
# until an archive update moves a package to a newer version (doriterm#1022), when the set is downloaded and saved again.
# doriterm#915: skipping these packages once cost the Korean width assertions their CJK fonts. So the cache never decides
# on its own: Playwright's `install-deps --dry-run` simulates installing its whole list and exits non-zero naming
# anything missing, and only when it passes is the mirror skipped. Otherwise this falls through to the mirror.
set -euo pipefail

debs="${1:?usage: playwright-linux-deps.sh <deb cache dir>}"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# apt's own paths; tests point them at a scratch directory.
archives="${PLAYWRIGHT_APT_ARCHIVES:-/var/cache/apt/archives}"
conf="${PLAYWRIGHT_APT_CONF:-/etc/apt/apt.conf.d/99-playwright-ci}"
save=false

# A configuration file rather than -o options, so the limits reach the apt-get calls install-deps makes itself. The
# Acquire limits are apt-bounds.conf's, which apt-bounds.sh also writes, so the two cannot drift apart; keeping the
# archive afterwards means what is in it is exactly the cached files plus what this run downloaded. The archive is
# emptied first.
{ cat "$here/apt-bounds.conf"; printf '%s\n' 'APT::Keep-Downloaded-Packages "true";'; } |
  sudo tee "$conf" >/dev/null
sudo apt-get clean

if compgen -G "$debs/*.deb" >/dev/null; then
  echo "apt cache hit: installing $(find "$debs" -name '*.deb' | wc -l) cached packages without the mirror"
  # Not `apt-get install <files>`: with the runner's package lists present, apt fetches the repository's copy of a
  # version a local file also carries (#1013's first run). Files in apt's own archive directory count as downloaded,
  # and --no-download makes a cache that falls short fail here instead of quietly using the mirror.
  sudo cp "$debs"/*.deb "$archives"/
  mapfile -t names < <(for f in "$debs"/*.deb; do dpkg-deb -f "$f" Package; done)
  if sudo apt-get install -y --no-install-recommends --no-download "${names[@]}" \
    && bunx playwright install-deps --dry-run chromium; then
    echo "save-debs=$save" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  # doriterm#1022: an archive update since the cache was filled makes its versions stale, and a list that grew (a
  # runner image that stops shipping a package) needs one the cache never held. The cached files stay in the archive,
  # so the mirror install below downloads only what they do not cover.
  echo "::warning::the cached packages do not cover Playwright's list; installing the rest from the apt mirror and caching the whole set"
fi

timeout 300 bunx playwright install-deps chromium

# The new cache is every file in the archive whose version is the one now installed: the cached files that still count
# and what the mirror added, without a version an update replaced. Saving only the mirror's downloads would cut the
# cache down to the missing packages, so the next run would fall back again and the set would flip between the two.
# The workflow saves it under a key of its own (one per run), and restoring by the key's prefix picks the newest set.
fresh="$debs.next"
rm -rf "$fresh"
mkdir -p "$fresh"
for f in "$archives"/*.deb; do
  [ -e "$f" ] || continue
  package=$(dpkg-deb -f "$f" Package)
  if [ "$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null)" = "$(dpkg-deb -f "$f" Version)" ]; then
    cp "$f" "$fresh"/
  fi
done
if compgen -G "$fresh/*.deb" >/dev/null; then
  rm -rf "$debs"
  mv "$fresh" "$debs"
  echo "caching $(find "$debs" -name '*.deb' | wc -l) packages for the next run"
  save=true
else
  rm -rf "$fresh"
fi
echo "save-debs=$save" >> "$GITHUB_OUTPUT"
