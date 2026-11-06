#!/usr/bin/env bash
# The host installer on a clean runner (#668): from a release directory holding this commit's compiled doriface-host
# and its SHA256SUMS.txt, apps/host/install/install.sh must end with herdr-core installed, the host running as a user
# service with a relay slot, and a printed QR code; a second run upgrades in place and --uninstall removes it.
# Usage: install-smoke.sh <os-arch> (linux-x64 or mac-arm64), from the repository root after `bun install`.
set -euo pipefail

target="$1"
case "$target" in
  linux-*) os=linux ;;
  mac-*) os=mac ;;
  *) echo "::error::unknown target $target" && exit 2 ;;
esac

if command -v hc >/dev/null 2>&1 || [ -e "$HOME/.local/bin/hc" ]; then
  echo "::error::this runner already has hc, so it cannot show the installer installing it"
  exit 1
fi

bun run --cwd apps/desktop build:host "$target"
release="$RUNNER_TEMP/release"
mkdir -p "$release"
cp "apps/desktop/dist/host/$target/doriface-host" "$release/doriface-host-$target"
(cd "$release" && shasum -a 256 "doriface-host-$target" > SHA256SUMS.txt && cat SHA256SUMS.txt)

service_running() {
  if [ "$os" = linux ]; then
    [ "$(systemctl --user is-active doriface-host.service)" = active ]
  else
    launchctl print "gui/$(id -u)/dev.omo.doriface-host" | grep -q 'state = running'
  fi
}

out="$RUNNER_TEMP/install.out"
sh apps/host/install/install.sh --from "file://$release" 2>&1 | tee "$out"

"$HOME/.local/bin/hc" --version
service_running || { echo "::error::the host service is not running after the install"; exit 1; }
grep -q '^doriface://pair#' "$out" || { echo "::error::the install printed no pairing link"; exit 1; }
grep -q '▀\|▄\|█' "$out" || { echo "::error::the install printed no QR code"; exit 1; }
grep -q '^code        ' "$out" || { echo "::error::the install printed no pairing code"; exit 1; }
if grep -q 'not registered with the relay\|no relay slot' "$out"; then
  echo "::error::the running host opened the offer without a relay slot"
  exit 1
fi

# The service runs at the highest priority a user service can have (#668): read it back from the running service.
if [ "$os" = linux ]; then
  systemctl --user show doriface-host.service -p MainPID -p Restart -p CPUWeight -p IOWeight -p Nice | tee "$RUNNER_TEMP/priority.txt"
  pid="$(systemctl --user show doriface-host.service -p MainPID --value)"
  for want in Restart=always CPUWeight=10000 IOWeight=10000; do
    grep -qx "$want" "$RUNNER_TEMP/priority.txt" || { echo "::error::the running service has no $want"; exit 1; }
  done
  cat "/proc/$pid/cgroup"
  for core in $(pgrep -f 'herdr-core' || true); do
    echo "== core $core: $(tr '\0' ' ' < "/proc/$core/cmdline")"
    cat "/proc/$core/cgroup"
  done
else
  plist="$HOME/Library/LaunchAgents/dev.omo.doriface-host.plist"
  [ "$(plutil -extract ProcessType raw "$plist")" = Interactive ] || { echo "::error::ProcessType is not Interactive"; exit 1; }
  launchctl print "gui/$(id -u)/dev.omo.doriface-host" | tee "$RUNNER_TEMP/priority.txt" | grep -iE 'spawn type|pid =|state ='
  pid="$(awk '/^\tpid = / { print $3; exit }' "$RUNNER_TEMP/priority.txt")"
  # The core hc starts runs under its own launchd job; its class decides how fast the host's terminals are.
  launchctl print "gui/$(id -u)" | grep -iE 'herdr|hc' || echo "no herdr launchd job listed"
  for job in $(launchctl list | awk 'tolower($3) ~ /herdr/ { print $3 }'); do
    echo "== $job"
    launchctl print "gui/$(id -u)/$job" | grep -iE 'spawn type|program|pid =|state =' || true
  done
fi
ps -o pid,ni,pri,comm -p "$pid"
ps -o pid,ni,pri,comm -ax | grep -iE 'herdr|hc' | grep -v grep || true

sh apps/host/install/install.sh --from "file://$release" --no-pair
service_running || { echo "::error::the host service is not running after an upgrade"; exit 1; }

sh apps/host/install/install.sh --uninstall
if service_running; then
  echo "::error::the host service still runs after --uninstall"
  exit 1
fi
[ ! -e "$HOME/.local/bin/doriface-host" ] || { echo "::error::--uninstall left the binary"; exit 1; }
echo "install smoke passed on $target"
