#!/usr/bin/env bash
# Bounds every apt-get call that follows on this runner, the ones `playwright install --with-deps` and
# `playwright install-deps` make themselves included (doriterm#914): apt otherwise retries a mirror that stopped
# answering for as long as it is allowed to, and on #855 that was the whole job. A configuration file rather than -o
# options, because those calls are Playwright's and take no options from us. The values are apt-bounds.conf's, which
# playwright-linux-deps.sh writes too, so the two cannot drift apart.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# apt's own path; tests point it at a scratch directory.
conf="${APT_BOUNDS_CONF:-/etc/apt/apt.conf.d/98-ci-bounds}"
sudo tee "$conf" <"$here/apt-bounds.conf" >/dev/null
