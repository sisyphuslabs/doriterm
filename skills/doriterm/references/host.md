# The host: relay, mesh and pairing

`doriface-host` runs beside `hc` on each machine. It keeps an end-to-end encrypted uplink to the relay, so a phone, a browser or another machine reaches this machine's `hc` with no open port, no ssh and no VPN. Machines in one mesh appear in each other's `hc machine ls` and in the Doriterm app's sidebar. Commands below take `--state-dir <dir>` when the host does not use the default.

## Install or update

| Where                                                  | How                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Desktop (macOS, Windows, Linux)                        | The Doriterm app from https://get.doriterm.com. **Use this computer** starts its own host and offers to install herdr-core. |
| Server or headless machine (Linux with systemd, macOS) | `curl -fsSL https://get.doriterm.com \| sh`, as the user, never root.                                                       |
| A checkout of the repository                           | `skills/doriterm-setup` in the repository.                                                                                  |

The installer downloads the host for this OS and CPU, checks it against the release's signed checksums, installs herdr-core when `hc` is missing, registers a user service, turns lingering on (Linux), then prints a pairing QR code. Running it again upgrades in place and keeps the same keys. Useful flags: `--no-pair`, `--channel beta`, `--no-auto-update`, `--uninstall` (keeps keys and paired devices). The service updates itself from the signed stable channel unless told not to; `doriface-host update` updates now.

|                             | Linux                                | macOS                               |
| --------------------------- | ------------------------------------ | ----------------------------------- |
| Service                     | systemd user unit `doriface-host`    | LaunchAgent `dev.omo.doriface-host` |
| Log                         | `journalctl --user -u doriface-host` | `~/Library/Logs/doriface-host.log`  |
| State (keys, devices, mesh) | `~/.local/state/doriface-host`       | `~/.local/state/doriface-host`      |

A host installed from a checkout uses `~/.local/state/doriface-host-mesh` instead. Keep whichever a machine already has; its keys are its identity in the mesh.

## Read the state first

```sh
doriface-host --version
doriface-host mesh status            # members and the line to each (--json for data)
```

| Line                                        | Meaning                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `self`                                      | this machine                                      |
| `connected`                                 | reachable through the mesh now                    |
| `connecting`                                | being dialed; a new member takes about 20 seconds |
| `absent`                                    | no line now; normal for a closed phone or browser |
| `unreachable`, `hc_missing`, `incompatible` | broken, with the reason beside it                 |

`mesh status` exits 1 when this host is in no mesh yet, and fails when no host runs on that state dir. The relay state is in the host log: `relay: connected to ...`, `connecting to`, `uplink closed`, `uplink stopped`.

## Add a machine to the mesh

On a member, `mesh pair --auto` opens a single-use offer for 10 minutes and admits the first machine that uses it. The link it prints admits that machine without asking, so keep it in a file only you can read and pass it on stdin:

```sh
umask 077
doriface-host mesh pair --auto --no-qr | grep -E '^(doriface|https?)://[^ ]*pair#' > ~/doriterm-invite
test -s ~/doriterm-invite || echo 'no invite: is a host running here?'
```

The joining machine already runs a host:

```sh
hc exec -i --on new-box --timeout 180 -- sh -c 'f=$(mktemp); cat > "$f"; doriface-host mesh join --yes --from-file "$f"; s=$?; rm -f "$f"; exit $s' < ~/doriterm-invite
```

It has no host yet (the installer joins when `DORIFACE_JOIN` holds the link):

```sh
hc exec -i --on new-box --timeout 600 -- sh -c 'DORIFACE_JOIN="$(cat)" sh -c "curl -fsSL https://get.doriterm.com | sh -s -- --no-pair"' < ~/doriterm-invite
```

Then `rm -f ~/doriterm-invite`, and check `doriface-host mesh status` on any member until the new machine reads `connected`.

- `new-box` must be reachable by hc first: `hc machine add --install me@new-box --name new-box`, with key login that needs no prompt. Without ssh between the two machines, move the invite file any private way and run `doriface-host mesh join --yes --from-file <file>` on the new machine.
- Join one machine at a time.
- A machine in another mesh must leave it first (`doriface-host mesh leave` there). A host running as root hands every member a root shell; install as a normal user.
- A Linux machine needs a systemd user manager, which a real ssh login or console session provides and most containers lack.

## Remove or rename a member

```sh
doriface-host mesh rename <member> <new name>
doriface-host mesh revoke <member>                 # <member> is its mesh name or host id
doriface-host mesh revoke --compromised <member>   # also removes every member it admitted
doriface-host mesh leave                           # take this machine out
```

A revoke or leave is permanent for every member, and the machine must join again to come back. Show the user the member from `mesh status` and get their yes first. Some revokes and leaves ask for confirmation on the terminal; after the user's yes, pass `--yes` so the command does not wait on a prompt nobody sees.

## Phones and browsers

```sh
doriface-host pair            # QR code, link and 8-character code, valid for 10 minutes
doriface-host devices list
doriface-host devices revoke <id>
```

Scan the QR code with the phone (it opens app.doriterm.com/pair), or open https://app.doriterm.com/pair and type the code. The phone then shows the host's key; it should match `doriface-host fingerprint`. In the desktop app the same flow is **Settings > Machines > Pair a device**.

## When something is off

| What you see                                               | What to do                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A member stuck `connecting`, or the log keeps reconnecting | The host retries by itself; outbound HTTPS to the relay must be allowed. Read the host log.                                             |
| `mesh status` says no host is running                      | Start the service (`systemctl --user start doriface-host`, or `launchctl kickstart gui/$(id -u)/dev.omo.doriface-host`), or install it. |
| `mesh status` exits 1                                      | This host is in no mesh. The first `mesh pair` starts one.                                                                              |
| `hc exec --on` answers `needs_login` or unreachable        | Fix the ssh key or alias, then `hc machine login <name>`.                                                                               |
| A machine is missing everywhere                            | `mesh status` on a member lists revoked members last; a revoked machine has to join again.                                              |
| No systemd user manager                                    | Log in over ssh or at the console and run again; `sudo` and `su` sessions have none.                                                    |
