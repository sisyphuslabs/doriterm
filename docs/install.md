# Set up the host on every machine you own

Each machine you want to reach runs one `doriface-host` next to herdr-core (`hc`). The host keeps an end-to-end encrypted uplink to the relay at `relay-doriface.omo.dev`, so a phone, a browser or another machine reaches it with no open port and no ssh. This guide sets the host up as a user service on Linux and macOS, joins your machines into one mesh, and pairs your phones and browsers.

The fastest way is to hand the [doriterm-setup skill](../skills/doriterm-setup/SKILL.md) to a coding agent on each machine. It runs the same commands this guide shows, checks each result, and never prints a join link or a key. Every step below also works by hand.

## What you need

- Linux with systemd, or macOS. On Windows, install the [desktop app](https://get.doriterm.com), which carries its own host.
- `git` and [Bun](https://bun.sh) 1.4.4 or newer (`curl -fsSL https://bun.sh/install | bash`).
- herdr-core is installed for you (into `~/.local/bin/hc`) when it is missing or older than the version the host needs.

The host runs from a checkout of this repository. A one-step installer that downloads a compiled host instead is coming with [#721](https://github.com/sisyphuslabs/doriterm/pull/721); until it ships in a release, use the steps here.

## 1. Install or update the host

On each machine, as your own user (never root):

```sh
git clone https://github.com/sisyphuslabs/doriterm.git ~/.local/share/doriface-host/src
cd ~/.local/share/doriface-host/src && bun install --frozen-lockfile
bun apps/host/scripts/setup/cli.ts install
```

`install` moves the checkout to the newest `dev`, installs herdr-core if needed, writes the service, starts it, and waits until the host logs `relay: connected`. Each line it prints is one step: `changed` means it did something, `unchanged` means that part was already right. Run the same command again to update; on a machine that is already current it changes nothing and restarts nothing. A checkout with local edits is refused, never reset.

What it writes:

|                                    | Linux                                                                                | macOS                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Service                            | `~/.config/systemd/user/doriface-host.service` (systemd user unit, `Restart=always`) | `~/Library/LaunchAgents/com.sisyphuslabs.doriface-host.plist` (LaunchAgent, `KeepAlive`) |
| Host log                           | `~/.local/state/doriterm-setup/doriface-host.log`                                    | `~/Library/Logs/com.sisyphuslabs.doriface-host.log`                                      |
| State (keys, paired devices, mesh) | `~/.local/state/doriface-host-mesh`                                                  | `~/.local/state/doriface-host-mesh`                                                      |
| Checkout                           | `~/.local/share/doriface-host/src`                                                   | `~/.local/share/doriface-host/src`                                                       |

Keep the checkout where it is: the host starts other machines' mesh lines through a launcher in its state dir that runs this checkout.

On Linux, a user service stops when you log out unless linger is on. `install` turns it on with `loginctl enable-linger` and says so; if it warns that linger is off, run the command the warning names once (`sudo loginctl enable-linger <user>`). `install` also needs a systemd user manager, which a login over ssh or a console session gives you (most containers have none).

On macOS the LaunchAgent starts at login and restarts the host if it stops.

### The desktop app on the same machine

The desktop app's "Use this computer" starts its own host with the default state dir (`~/.local/state/doriface-host`) on a random loopback port. The service uses `~/.local/state/doriface-host-mesh`, so the two never share keys or devices. If a machine already runs a service that uses the default dir, `install` keeps that dir and warns you; keep "Use this computer" off on that machine.

## 2. Check it

```sh
bun ~/.local/share/doriface-host/src/apps/host/scripts/setup/cli.ts verify
```

It reports whether the service runs, the host's last `relay:` line, and the mesh as the running host sees it. It exits non-zero when something is wrong, and the failing line names the part.

## 3. Join your machines into one mesh

A mesh lets each machine reach every other one through the relay: `hc` on any member lists the others as machines, with no ssh entry. Pick one machine to start from, then add the others one at a time.

On a machine that is already in the mesh (for the first join, the machine you start from):

```sh
bun ~/.local/share/doriface-host/src/apps/host/scripts/setup/cli.ts invite --out ~/doriterm-invite
```

This writes a single-use join link, valid for 10 minutes, to `~/doriterm-invite` with mode 0600, and prints only the host's fingerprint. The link admits one machine without asking, so move it the way you would move a key, for example `scp ~/doriterm-invite other-machine:`.

On the machine that joins:

```sh
bun ~/.local/share/doriface-host/src/apps/host/scripts/setup/cli.ts join --from ~/doriterm-invite
```

It joins, then deletes the spent link. Repeat with a fresh `invite` for each machine. Check with `verify --min-members <how many machines>` on any member: each other member should show `connected`.

Under the hood these are the host's own commands, `doriface-host mesh pair --auto` and `doriface-host mesh join`, plus `doriface-host mesh status`, `mesh rename` and `mesh leave` (`bun ~/.local/share/doriface-host/src/apps/host/src/cli.ts mesh --help`).

## 4. Pair a phone or a browser

```sh
bun ~/.local/share/doriface-host/src/apps/host/scripts/setup/cli.ts pair
```

This prints a QR code, a link and an 8-character code, valid once for 10 minutes. Scan the QR code with the phone's camera: it opens [app.doriterm.com/pair](https://app.doriterm.com/pair) with the pairing filled in, and you can install the web app from there. The printed link opens in the desktop app on another computer. Without a camera, type the code in the web app's pairing screen and check that the fingerprint it shows matches the one printed.

Pair each device once with one machine; through the mesh it reaches all of them.

## Update, remove

- Update: run `install` again.
- Remove: `bun ~/.local/share/doriface-host/src/apps/host/scripts/setup/cli.ts uninstall` stops the service and deletes the unit or plist. Keys, paired devices, the mesh and the checkout stay, so `install` brings the same host back.

## When something is off

| What you see                                                                          | What to do                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no systemd user manager answers`                                                     | Log in over ssh or at the console and run again; `sudo` and `su` sessions have no user manager.                                                                                                                      |
| `relay` fails, or `verify` shows `reconnecting`                                       | Read the host log (paths above). The host retries on its own; a firewall must allow outbound HTTPS to `relay-doriface.omo.dev`.                                                                                      |
| `... runs another install`                                                            | A unit or plist from somewhere else (for example the one-step installer) already runs a host. Remove that install first, or run this one beside it with its own `--label`, `--state-dir` and `--listen 127.0.0.1:0`. |
| `has local changes`                                                                   | Commit or drop your edits in the checkout, then run again.                                                                                                                                                           |
| A member stays `connecting` in `mesh status` while `hc machine ls` shows it connected | The status keeps the line state of its last roster check and catches up at the next change. `verify` reads each line's state from `hc machine ls` instead.                                                           |
| `verify` fails right after a join                                                     | A new member's line comes up about 20 seconds after the join, once the mesh settles; run `verify` again.                                                                                                             |

Every command takes `--state-dir`, `--src`, `--label`, `--listen` and `--session` (an hc session, which is a separate core) to override the defaults; `--help` lists them. To run a second host on one machine, for a second hc session, give it its own `--label`, `--state-dir` and `--listen 127.0.0.1:0` as well.
