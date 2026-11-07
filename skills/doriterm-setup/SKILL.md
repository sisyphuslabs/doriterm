---
name: doriterm-setup
description: Sets up, updates or checks the doriterm host (doriface-host) on this machine as a user service connected to the relay, joins it to the user's mesh of machines, and pairs phones or browsers. Use when the user asks to install doriterm or doriface on a machine, add a machine to their mesh, connect a machine to the relay, update the host, or check why a machine does not show up.
---

# doriterm-setup

Run this on each machine the user wants to reach, as the user (never root, never sudo). Every command is safe to run again: a machine that is already set up reports `unchanged` and nothing restarts. The full human guide is `docs/install.md` in the checkout.

## Rules

- Never print, paste or echo a join link, a pairing link or code, a key, or the contents of the state dir. The script writes invite links to a 0600 file and prints only fingerprints; keep it that way when you report.
- Never stop, kill or edit another host process, unit or plist. If `install` refuses because something else runs a host, report that and stop.
- Never use `sudo`. If linger needs an admin, tell the user the one command to run.
- Windows: stop and tell the user to install the desktop app, which carries the host.

## Steps

All commands below use `S=~/.local/share/doriface-host/src` and `SETUP="bun $S/apps/host/scripts/setup/cli.ts"`. Each output line reads `doriterm-setup: <step> <ok|changed|unchanged|warn|fail> <detail>`, and the last line is `doriterm-setup: result ok|fail`.

1. Prerequisites: `uname -s` must be Linux or Darwin. `git --version` must work. `bun --version` must be 1.4.4 or newer; if bun is missing, install it with `curl -fsSL https://bun.sh/install | bash` and use `~/.bun/bin/bun`.
2. Checkout, first time only: if `$S/.git` does not exist, run `git clone https://github.com/sisyphuslabs/doriterm.git $S && (cd $S && bun install --frozen-lockfile)`.
3. Install or update: `$SETUP install`. It moves the checkout to the newest `dev`, installs herdr-core when missing or too old, writes the systemd user unit (Linux) or LaunchAgent (macOS), starts it, and waits for `relay: connected`. On `result fail`, read the `fail` line and the host log it names, fix that one thing, and run `install` again. On a `linger warn` line, tell the user to run `sudo loginctl enable-linger <user>` once.
4. Check: `$SETUP verify`. All of `running`, `relay` and `mesh` must read `ok`.
5. Mesh, only when the user has more than one machine:
   - On a machine already in the mesh (or the first machine, which starts the mesh): `$SETUP invite --out ~/doriterm-invite`. The link is single use and expires in 10 minutes.
   - Move the file to the joining machine without printing it (for example `scp ~/doriterm-invite <machine>:` or `hc file read ~/doriterm-invite | hc file write --on <machine> ~/doriterm-invite`), then on that machine: `$SETUP join --from ~/doriterm-invite`. It deletes the spent file.
   - Join one machine at a time, then run `$SETUP verify --min-members <count>` on each member: every other member must read `connected`. A new line comes up about 20 seconds after the join, so retry `verify` for up to a minute before reporting a failure.
6. Phone or browser: tell the user to run `$SETUP pair` in their own terminal and scan the QR code with the phone (it opens app.doriterm.com/pair), or type the code and compare the fingerprint. Do not run `pair` yourself unless the user asks you to show them the output, since it prints a live pairing code.

## Report

Tell the user, per machine: the OS, `install` result, the `relay` line, and the mesh members with their line state from `verify`. Quote the `fail` line when there is one. Never include links, codes or file contents.

## Options

`--state-dir`, `--src`, `--label`, `--listen` and `--session` (an hc session, a separate core) override the defaults (state dir `~/.local/state/doriface-host-mesh`, label `com.sisyphuslabs.doriface-host` on macOS and unit `doriface-host` on Linux, listener `127.0.0.1:7766`). Once a service is installed, later runs reuse its state dir, and its `--listen` and `--session`; `--listen default` or `--session default` puts it back on the default. `--ref <branch>` installs another branch. `$SETUP uninstall` removes the service and keeps keys, devices, mesh and checkout.
