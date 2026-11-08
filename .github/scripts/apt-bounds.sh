#!/usr/bin/env bash
# Bounds every apt-get call that follows on this runner, the ones `playwright install --with-deps` and
# `playwright install-deps` make themselves included (doriterm#914): apt otherwise retries a mirror that stopped
# answering for as long as it is allowed to, and on #855 that was the whole job. A configuration file rather than -o
# options, because those calls are Playwright's and take no options from us.
set -euo pipefail

printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "15";' 'Acquire::https::Timeout "15";' |
  sudo tee /etc/apt/apt.conf.d/98-ci-bounds >/dev/null
