#!/bin/sh
# doriface host installer for Linux and macOS (#668).
#
#   curl -fsSL https://github.com/sisyphuslabs/doriface/releases/latest/download/install.sh | sh
#
# One step: downloads doriface-host for this OS and CPU and checks it against the release's SHA256SUMS.txt, installs
# herdr-core when no `hc` is found, registers the host as a user service (systemd --user on Linux, a LaunchAgent on
# macOS) so it starts at login and restarts if it stops, then waits for it and prints a pairing QR code, link and code.
# Running it again upgrades the host in place and restarts the service; `--uninstall` removes the service and the
# binary and keeps the host's keys and paired devices.
set -eu

REPO_RELEASES="https://github.com/sisyphuslabs/doriface/releases"
# The release workflow stamps its tag here, so a published install.sh installs the release it came with.
release="__DORIFACE_RELEASE__"
SERVICE_LABEL="dev.omo.doriface-host"

usage() {
  cat <<'EOF'
usage: install.sh [options]

  --version <vX.Y.Z>    the release to install (default: the one this script came with, else the latest)
  --web-origin <url>    the web app the pairing QR code and link open (default: the doriface desktop app's link)
  --join <link>         join the mesh of the host that made this link (the app's Add a machine command), instead
                        of printing a pairing
  --bin-dir <dir>       where doriface-host goes (default ~/.local/bin)
  --from <url>          the release's download base, file:// included (default: the GitHub release)
  --no-service          install only; start doriface-host yourself
  --no-pair             skip printing the pairing QR code
  --uninstall           stop and remove the service and the binary; keys and paired devices stay
  -h, --help            show this help
EOF
}

say() { printf 'doriface: %s\n' "$*"; }
fail() {
  printf 'doriface: %s\n' "$*" >&2
  exit 1
}

version=""
web_origin=""
bin_dir="${HOME}/.local/bin"
from="${DORIFACE_RELEASE_BASE:-}"
service=1
pair=1
uninstall=0
join=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version wants a value"; version="$2"; shift 2 ;;
    --web-origin) [ $# -ge 2 ] || fail "--web-origin wants a URL"; web_origin="$2"; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || fail "--bin-dir wants a directory"; bin_dir="$2"; shift 2 ;;
    --from) [ $# -ge 2 ] || fail "--from wants a URL"; from="$2"; shift 2 ;;
    --join) [ $# -ge 2 ] || fail "--join wants a mesh link"; join="$2"; shift 2 ;;
    --no-service) service=0; shift ;;
    --no-pair) pair=0; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=mac ;;
  *) fail "this installer covers Linux and macOS; on Windows, install the desktop app, which carries the host" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no doriface-host build for CPU $(uname -m)" ;;
esac
asset="doriface-host-${os}-${arch}"
host_bin="${bin_dir}/doriface-host"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit="${unit_dir}/doriface-host.service"
# Named once and passed to the service and to every command below, so they all use the same keys and devices.
state_dir="${DORIFACE_HOST_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/doriface-host}"
plist="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"

have() { command -v "$1" >/dev/null 2>&1; }

# systemd --user answers only inside a login session with a user manager (not in most containers).
user_systemd() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

stop_service() {
  if [ "$os" = linux ]; then
    if [ -f "$unit" ] && user_systemd; then
      systemctl --user disable --now doriface-host.service >/dev/null 2>&1 || true
    fi
  else
    launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  fi
}

if [ "$uninstall" -eq 1 ]; then
  stop_service
  rm -f "$unit" "$plist" "$host_bin"
  if [ "$os" = linux ] && user_systemd; then systemctl --user daemon-reload; fi
  say "removed the doriface-host service and ${host_bin}; its keys and paired devices stay in its state dir"
  exit 0
fi

# Fail before downloading anything when the service cannot be registered.
if [ "$service" -eq 1 ]; then
  if [ "$os" = linux ] && ! user_systemd; then
    fail "no systemd user manager answers here (systemctl --user), so the host cannot run as a service; rerun with --no-service and start doriface-host yourself"
  fi
  if [ "$os" = mac ] && ! have launchctl; then
    fail "launchctl is missing, so the host cannot run as a LaunchAgent; rerun with --no-service"
  fi
fi

have curl || fail "curl is needed to download doriface-host"
# Matched by its shape, never by the placeholder's text, which the stamp replaces on every line it appears.
case "$release" in
  v[0-9]*) [ -n "$version" ] || version="$release" ;;
esac
if [ -z "$from" ]; then
  if [ -z "$version" ]; then from="${REPO_RELEASES}/latest/download"; else from="${REPO_RELEASES}/download/${version}"; fi
fi

sha256() {
  if have sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is needed to check the download"
  fi
}

work="$(mktemp -d "${TMPDIR:-/tmp}/doriface-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

say "downloading ${asset} from ${from}"
curl -fsSL --retry 3 -o "${work}/${asset}" "${from}/${asset}" || fail "could not download ${from}/${asset}"
curl -fsSL --retry 3 -o "${work}/SHA256SUMS.txt" "${from}/SHA256SUMS.txt" || fail "could not download ${from}/SHA256SUMS.txt"
expected="$(awk -v name="$asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) print $1 }' "${work}/SHA256SUMS.txt")"
[ -n "$expected" ] || fail "SHA256SUMS.txt names no ${asset}"
actual="$(sha256 "${work}/${asset}")"
[ "$expected" = "$actual" ] || fail "${asset} does not match SHA256SUMS.txt (expected ${expected}, got ${actual}); nothing was installed"

mkdir -p "$bin_dir"
chmod 755 "${work}/${asset}"
# Same directory, then rename: a running service keeps its old binary until the restart below.
cp "${work}/${asset}" "${host_bin}.new"
mv -f "${host_bin}.new" "$host_bin"
say "installed doriface-host at ${host_bin}"

hc_path=""
if have hc; then
  hc_path="$(command -v hc)"
elif [ -x "${HOME}/.local/bin/hc" ]; then
  hc_path="${HOME}/.local/bin/hc"
fi
if [ -z "$hc_path" ]; then
  say "herdr-core (hc) is missing; installing it"
  "$host_bin" --install-hc
  hc_path="${HOME}/.local/bin/hc"
  [ -x "$hc_path" ] || fail "herdr-core did not land at ${hc_path}"
else
  say "using herdr-core at ${hc_path} ($("$hc_path" --version 2>/dev/null || echo 'version unknown'))"
fi

if [ "$service" -eq 0 ] && [ -n "$join" ]; then
  "$host_bin" mesh join --yes --hc "$hc_path" --state-dir "$state_dir" "$join"
  say "joined; start the host with: ${host_bin} --hc ${hc_path}"
  exit 0
fi
if [ "$service" -eq 0 ]; then
  say "start the host with: ${host_bin} --hc ${hc_path} --state-dir ${state_dir}"
  say "then pair a device with: ${host_bin} pair --state-dir ${state_dir}"
  exit 0
fi

# The service runs with this shell's PATH and SHELL, so the terminals it opens find the same tools.
service_path="${bin_dir}:$(dirname "$hc_path"):${PATH}"
service_shell="${SHELL:-/bin/sh}"

# systemd reads % as a specifier in unit values; a literal one is written %%.
sd() { printf '%s' "$1" | sed 's/%/%%/g'; }

if [ "$os" = linux ]; then
  mkdir -p "$unit_dir"
  cat >"$unit" <<EOF
[Unit]
Description=doriface host gateway beside herdr-core
After=network-online.target

[Service]
ExecStart="$(sd "$host_bin")" --hc "$(sd "$hc_path")" --state-dir "$(sd "$state_dir")"
Environment="PATH=$(sd "$service_path")" "SHELL=$(sd "$service_shell")"
Restart=always
RestartSec=2
# The highest share a user unit can ask for; a negative Nice needs privilege, so none is set.
CPUWeight=10000
IOWeight=10000

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable doriface-host.service >/dev/null
  systemctl --user restart doriface-host.service
  say "doriface-host runs as the systemd user service doriface-host.service (logs: journalctl --user -u doriface-host)"
  if have loginctl && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    say "it stops when you log out; to keep it running after logout and start it at boot, run: loginctl enable-linger $(id -un)"
  fi
else
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$host_bin")</string>
    <string>--hc</string>
    <string>$(xml "$hc_path")</string>
    <string>--state-dir</string>
    <string>$(xml "$state_dir")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$service_path")</string>
    <key>SHELL</key><string>$(xml "$service_shell")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "${HOME}/Library/Logs/doriface-host.log")</string>
  <key>StandardErrorPath</key><string>$(xml "${HOME}/Library/Logs/doriface-host.log")</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  # bootout returns before launchd has unloaded the old agent, and bootstrap fails with 5 (EIO) until it has.
  waited=0
  while launchctl print "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -le 100 ] || fail "the old ${SERVICE_LABEL} did not unload within 10 s; run: launchctl bootout gui/$(id -u)/${SERVICE_LABEL}"
    sleep 0.1
  done
  launchctl bootstrap "gui/$(id -u)" "$plist"
  say "doriface-host runs as the LaunchAgent ${SERVICE_LABEL} (logs: ~/Library/Logs/doriface-host.log)"
fi

if [ -n "$join" ]; then
  "$host_bin" mesh join --wait-host 60 --yes --state-dir "$state_dir" "$join"
  say "this machine joined the mesh; its terminals show in the app under its name"
elif [ "$pair" -eq 1 ]; then
  echo
  if [ -n "$web_origin" ]; then
    "$host_bin" pair --wait-host 60 --state-dir "$state_dir" --web-origin "$web_origin"
  else
    "$host_bin" pair --wait-host 60 --state-dir "$state_dir"
  fi
  echo
  say "pair another device later with: ${host_bin} pair --state-dir ${state_dir}"
fi
