#!/bin/sh
# Doriterm host installer for Linux and macOS (#668).
#
#   curl -fsSL https://get.doriterm.com | sh
#
# One step: downloads doriface-host for this OS and CPU from get.doriterm.com (GitHub Releases when that fails), checks
# it against the release's SHA256SUMS.txt and has it check that file's Ed25519 signature (#1969), installs
# herdr-core when no `hc` is found, registers the host as a user service (systemd --user on Linux, a LaunchAgent on
# macOS) so it starts at login and restarts if it stops, turns lingering on for the user on Linux so that it also
# starts at boot, then waits for it and prints a pairing QR code, link and code.
# Running it again upgrades the host in place and restarts the service; `--uninstall` removes the service and the
# binary and keeps the host's keys and paired devices. The service updates itself from the signed stable manifest
# (`--channel beta` for prereleases, `--no-auto-update` to leave updates to you).
set -eu

REPO_RELEASES="${DORIFACE_GITHUB_RELEASES:-https://github.com/sisyphuslabs/doriterm/releases}"
GET_ORIGIN="${DORIFACE_GET_ORIGIN:-https://get.doriterm.com}"
# The release workflow stamps its tag here, so a published install.sh installs the release it came with.
release="__DORIFACE_RELEASE__"
SERVICE_LABEL="dev.omo.doriface-host"

usage() {
  cat <<'EOF'
usage: install.sh [options]

  --version <vX.Y.Z>    the release to install (default: the one this script came with, else the latest)
  --web-origin <url>    the web app the pairing QR code and link open (default: the Doriterm desktop app's link)
  --join <link>         join the mesh of the host that made this link (the app's Add a machine command), instead
                        of printing a pairing; DORIFACE_JOIN=<link> does the same and keeps the link off this
                        script's command line, where other local users can read it
  --bin-dir <dir>       where doriface-host goes (default ~/.local/bin)
  --state-dir <dir>     the host's keys and paired devices (default: the one the installed service uses, else
                        ~/.local/state/doriface-host); DORIFACE_HOST_STATE_DIR=<dir> does the same
  --from <url>          the release's download base, file:// included (default: get.doriterm.com, then GitHub)
  --channel <name>      stable (default) or beta: the channel the service updates itself from
  --no-auto-update      the service never updates itself; run this script again to upgrade
  --no-service          install only; start doriface-host yourself
  --no-pair             skip printing the pairing QR code
  --uninstall           stop and remove the service and the binary; keys and paired devices stay
  -h, --help            show this help
EOF
}

say() { printf 'Doriterm: %s\n' "$*"; }
fail() {
  printf 'Doriterm: %s\n' "$*" >&2
  exit 1
}

version=""
web_origin=""
bin_dir="${HOME}/.local/bin"
from="${DORIFACE_RELEASE_BASE:-}"
service=1
pair=1
uninstall=0
join="${DORIFACE_JOIN:-}"
state_dir="${DORIFACE_HOST_STATE_DIR:-}"
auto_update=stable

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version wants a value"; version="$2"; shift 2 ;;
    --web-origin) [ $# -ge 2 ] || fail "--web-origin wants a URL"; web_origin="$2"; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || fail "--bin-dir wants a directory"; bin_dir="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || fail "--state-dir wants a directory"; state_dir="$2"; shift 2 ;;
    --from) [ $# -ge 2 ] || fail "--from wants a URL"; from="$2"; shift 2 ;;
    --join) [ $# -ge 2 ] || fail "--join wants a mesh link"; join="$2"; shift 2 ;;
    --channel)
      [ $# -ge 2 ] || fail "--channel wants stable or beta"
      case "$2" in stable | beta) auto_update="$2" ;; *) fail "--channel wants stable or beta, not $2" ;; esac
      shift 2
      ;;
    --no-auto-update) auto_update=off; shift ;;
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
# A service starts in its own working directory, so a relative path from this shell is resolved here, once (#834).
absolute() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd)" "$1" ;; esac; }
bin_dir="$(absolute "$bin_dir")"
asset="doriface-host-${os}-${arch}"
host_bin="${bin_dir}/doriface-host"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit="${unit_dir}/doriface-host.service"
plist="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"

have() { command -v "$1" >/dev/null 2>&1; }

# The --state-dir the installed service runs with, as the unit or plist written below spells it, else nothing.
installed_state_dir() {
  if [ "$os" = linux ]; then
    [ -f "$unit" ] || return 0
    # The quoted word sd_exec wrote: \ escapes the next character, and %% and $$ stand for % and $.
    awk '
      /^ExecStart=/ {
        i = index($0, " --state-dir")
        if (i == 0) exit
        s = substr($0, i + 12)
        if (substr(s, 1, 1) == "=") s = substr(s, 2); else sub(/^[ \t]+/, "", s)
        v = ""
        if (substr(s, 1, 1) == "\"") {
          s = substr(s, 2)
          while (s != "" && substr(s, 1, 1) != "\"") {
            if (substr(s, 1, 1) == "\\") s = substr(s, 2)
            v = v substr(s, 1, 1)
            s = substr(s, 2)
          }
        } else { v = s; sub(/[ \t].*/, "", v) }
        gsub(/%%/, "%", v); gsub(/\$\$/, "$", v)
        print v
        exit
      }' "$unit"
  else
    [ -f "$plist" ] || return 0
    # The <string> after --state-dir in ProgramArguments; a plist saved in binary form is read through plutil.
    { if have plutil; then plutil -convert xml1 -o - "$plist" 2>/dev/null || cat "$plist"; else cat "$plist"; fi; } | awk '
      { doc = doc $0 "\n" }
      END {
        found = 0
        while (!found && (i = index(doc, "<string>")) > 0) {
          doc = substr(doc, i + 8)
          j = index(doc, "</string>")
          if (j == 0) break
          v = substr(doc, 1, j - 1)
          doc = substr(doc, j + 9)
          if (want) found = 1
          else if (substr(v, 1, 12) == "--state-dir=") { v = substr(v, 13); found = 1 }
          else want = (v == "--state-dir")
        }
        if (!found) exit
        gsub(/&lt;/, "<", v); gsub(/&gt;/, ">", v); gsub(/&quot;/, "\"", v); gsub(/&amp;/, "\\&", v)
        print v
      }'
  fi
}

# Named once and passed to the service and to every command below, so they all use the same keys and devices. The
# keys are this host's identity on the mesh, so running the installer again keeps the state dir the installed service
# uses (#1966): only --state-dir or DORIFACE_HOST_STATE_DIR moves it, and only a fresh install takes the default.
if [ -z "$state_dir" ]; then
  state_dir="$(installed_state_dir)"
  [ -z "$state_dir" ] || say "keeping the state dir the installed service uses: ${state_dir}"
fi
state_dir="$(absolute "${state_dir:-${XDG_STATE_HOME:-${HOME}/.local/state}/doriface-host}")"

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
# A known version is fetched from get.doriterm.com first and from its GitHub release when that fails; --from (or
# DORIFACE_RELEASE_BASE) names the one base to use.
fallback=""
if [ -z "$from" ]; then
  if [ -z "$version" ]; then
    from="${REPO_RELEASES}/latest/download"
  else
    from="${GET_ORIGIN}/v/${version#v}"
    fallback="${REPO_RELEASES}/download/${version}"
  fi
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

# The binary and the checksums always come from the same base.
fetch_release() {
  say "downloading ${asset} from $1"
  curl -fsSL --retry 3 -A "doriterm-install ${DORIFACE_INSTALL_UA:-}" -o "${work}/${asset}" "$1/${asset}" &&
    curl -fsSL --retry 3 -A "doriterm-install ${DORIFACE_INSTALL_UA:-}" -o "${work}/SHA256SUMS.txt" "$1/SHA256SUMS.txt"
}
if ! fetch_release "$from"; then
  [ -n "$fallback" ] || fail "could not download ${from}/${asset}"
  say "${from} did not answer; using ${fallback}"
  from="$fallback"
  fetch_release "$from" || fail "could not download ${from}/${asset}"
fi
expected="$(awk -v name="$asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) print $1 }' "${work}/SHA256SUMS.txt")"
[ -n "$expected" ] || fail "SHA256SUMS.txt names no ${asset}"
actual="$(sha256 "${work}/${asset}")"
[ "$expected" = "$actual" ] || fail "${asset} does not match SHA256SUMS.txt (expected ${expected}, got ${actual}); nothing was installed"
chmod 755 "${work}/${asset}"
# Whether the release named (stamped, or given with --version) is one of the signed ones, v0.1.18 and later; a stamped
# script names its release even with --from (#2297). Releases before #1969 carry no signature, and the unstamped
# repository copy without --version names none, so for those the absence is only said (#1983).
signed_release() {
  [ -n "$version" ] || return 1
  printf '%s\n' "${version#v}" | awk -F '[.-]' '{ exit !($1 > 0 || $2 > 1 || ($2 == 1 && $3 >= 18)) }'
}
# The binary just checked holds the release's public key; it checks the checksums' signature. A signed release without
# its signature installs nothing; for an older one the absence is said, not fatal; a signature that does not verify
# never installs.
if curl -fsSL --retry 3 -o "${work}/SHA256SUMS.txt.sig" "${from}/SHA256SUMS.txt.sig" 2>/dev/null; then
  "${work}/${asset}" verify-release "${work}/SHA256SUMS.txt" "${work}/SHA256SUMS.txt.sig" ||
    fail "SHA256SUMS.txt is not signed by a Doriterm release key; nothing was installed"
elif signed_release; then
  fail "${version} is signed, but no SHA256SUMS.txt.sig came with it; nothing was installed"
else
  say "this release carries no SHA256SUMS.txt.sig; checked against SHA256SUMS.txt only"
fi

mkdir -p "$bin_dir"
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

# The link admits one machine into the mesh, so mesh join reads it from a file only this user can read, never from its
# command line, where other local users can read it while it runs (#1201). The file is gone when the install exits.
join_file() {
  (umask 077 && printf '%s\n' "$join" >"${work}/join")
  printf '%s' "${work}/join"
}

if [ "$service" -eq 0 ] && [ -n "$join" ]; then
  "$host_bin" mesh join --yes --hc "$hc_path" --state-dir "$state_dir" --from-file "$(join_file)"
  say "joined; start the host with: ${host_bin} --hc ${hc_path}"
  exit 0
fi
if [ "$service" -eq 0 ]; then
  say "start the host with: ${host_bin} --hc ${hc_path} --state-dir ${state_dir}"
  say "then pair a device with: ${host_bin} pair --state-dir ${state_dir}"
  exit 0
fi

# A host older than #1969 has no --auto-update; it is passed only to one that lists it.
update_args=""
if "$host_bin" --help 2>/dev/null | grep -q -- --auto-update; then update_args="$auto_update"; fi

# The service runs with this shell's PATH and SHELL, so the terminals it opens find the same tools.
service_path="${bin_dir}:$(dirname "$hc_path"):${PATH}"
service_shell="${SHELL:-/bin/sh}"

# A quoted word in a unit: systemd reads % as a specifier (written %%) and unescapes \ and " inside the quotes.
sd() { printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
# ExecStart also expands $VAR, so a literal $ is written $$ there; Environment= gives $ no meaning (#834).
sd_exec() { sd "$1" | sed 's/\$/$$/g'; }

if [ "$os" = linux ]; then
  mkdir -p "$unit_dir"
  cat >"$unit" <<EOF
[Unit]
Description=Doriterm host gateway beside herdr-core
After=network-online.target

[Service]
ExecStart="$(sd_exec "$host_bin")" --hc "$(sd_exec "$hc_path")" --state-dir "$(sd_exec "$state_dir")"${update_args:+ --auto-update $update_args}
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
  # Without linger systemd runs a user's services only while that user is logged in: the host would stop at logout and
  # stay down after a reboot until the next login. A user may turn it on for themself; where the system wants an admin
  # for it, the installer says so and never asks for a password or runs sudo.
  lingers() { [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]; }
  if have loginctl && ! lingers; then
    loginctl --no-ask-password enable-linger "$(id -un)" >/dev/null 2>&1 || true
    if lingers; then
      say "it starts at boot and keeps running after you log out (lingering is now on for $(id -un))"
    else
      say "it stops when you log out and does not start at boot, because lingering could not be turned on here; an admin can turn it on with: sudo loginctl enable-linger $(id -un)"
    fi
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
    <string>$(xml "$state_dir")</string>$(if [ -n "$update_args" ]; then printf '\n    <string>--auto-update</string>\n    <string>%s</string>' "$update_args"; fi)
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
    [ "$waited" -le 100 ] || fail "the old ${SERVICE_LABEL} did not unload within 10 s; see what holds it with: launchctl print gui/$(id -u)/${SERVICE_LABEL}"
    sleep 0.1
  done
  # launchd can still refuse the new agent for a moment after the old one has left `print` (5, EIO), and an agent left
  # booted out keeps this machine off the mesh until someone loads it by hand (#1966): the bootstrap is retried for
  # 10 s, and the install fails, saying how to load it, unless the agent is loaded at the end.
  tries=0
  until launchctl bootstrap "gui/$(id -u)" "$plist" 2>"${work}/bootstrap"; do
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || fail "launchd did not load ${SERVICE_LABEL} ($(cat "${work}/bootstrap")); load it with: launchctl bootstrap gui/$(id -u) ${plist}"
    sleep 0.1
  done
  launchctl print "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 ||
    fail "${SERVICE_LABEL} is not loaded after its bootstrap; load it with: launchctl bootstrap gui/$(id -u) ${plist}"
  say "doriface-host runs as the LaunchAgent ${SERVICE_LABEL} (logs: ~/Library/Logs/doriface-host.log)"
fi

if [ -n "$join" ]; then
  "$host_bin" mesh join --wait-host 60 --yes --state-dir "$state_dir" --from-file "$(join_file)"
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
