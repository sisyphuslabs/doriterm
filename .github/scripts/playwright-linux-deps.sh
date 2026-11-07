#!/usr/bin/env bash
# The system packages Playwright's Chromium needs on an Ubuntu runner, installed from a cache of their .deb files when
# that cache provably covers them, and from the apt mirror otherwise.
# Usage: playwright-linux-deps.sh <deb cache dir>, from apps/web (where bunx finds this repository's Playwright), with the
# directory restored by actions/cache. Writes save-debs=true to $GITHUB_OUTPUT when it filled an empty cache.
#
# doriterm#1012: on the ubuntu-24.04 image Chromium is missing nine font packages, 21.1 MB, and the Azure mirror has
# served them at about 38 kB/s - nothing stalls, so neither retries nor an http timeout help, and the download outlasts
# its time limit. They come from the frozen release pocket, so for one Playwright version (which decides the list) and
# one distribution (which decides the files) the same .deb files are downloaded every time; the cache key holds both.
# doriterm#915: skipping these packages once cost the Korean width assertions their CJK fonts. So the cache never decides
# on its own: Playwright's `install-deps --dry-run` simulates installing its whole list and exits non-zero naming
# anything missing, and only when it passes is the mirror skipped. Otherwise this falls through to the mirror.
set -euo pipefail

debs="${1:?usage: playwright-linux-deps.sh <deb cache dir>}"
save=false

if compgen -G "$debs/*.deb" >/dev/null; then
  echo "apt cache hit: installing $(find "$debs" -name '*.deb' | wc -l) cached packages without the mirror"
  # Not `apt-get install <files>`: with the runner's package lists present, apt fetches the repository's copy of a
  # version a local file also carries (#1013's first run). Files in apt's own archive directory count as downloaded,
  # and --no-download makes a cache that falls short fail here instead of quietly using the mirror.
  sudo cp "$debs"/*.deb /var/cache/apt/archives/
  mapfile -t names < <(for f in "$debs"/*.deb; do dpkg-deb -f "$f" Package; done)
  if sudo apt-get install -y --no-install-recommends --no-download "${names[@]}" \
    && bunx playwright install-deps --dry-run chromium; then
    echo "save-debs=$save" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "::warning::the cached packages do not cover Playwright's list; installing it from the apt mirror"
  cold=false
else
  cold=true
fi

# A configuration file rather than -o options, so the limits reach the apt-get calls install-deps makes itself. The
# archive is emptied first and kept afterwards, so what is left in it is exactly what this install downloaded.
printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "15";' 'Acquire::https::Timeout "15";' \
  'APT::Keep-Downloaded-Packages "true";' | sudo tee /etc/apt/apt.conf.d/99-playwright-ci >/dev/null
sudo apt-get clean
timeout 300 bunx playwright install-deps chromium

# A cache that was restored but fell short keeps its key, which cannot be saved over; only an empty one is filled.
if [ "$cold" = true ] && compgen -G "/var/cache/apt/archives/*.deb" >/dev/null; then
  mkdir -p "$debs"
  cp /var/cache/apt/archives/*.deb "$debs"/
  echo "caching $(find "$debs" -name '*.deb' | wc -l) packages for the next run"
  save=true
fi
echo "save-debs=$save" >> "$GITHUB_OUTPUT"
