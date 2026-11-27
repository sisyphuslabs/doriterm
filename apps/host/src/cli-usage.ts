import { DEFAULT_RELAY_URL } from "@doriface/crypto";

/** `doriface-host --help`: the serve options and every subcommand's one-line form. */
export const USAGE = `usage: doriface-host [options]
       doriface-host pair [options]
       doriface-host devices list|revoke <id>
       doriface-host mcp on|off|status [--state-dir <dir>]
       doriface-host fingerprint
       doriface-host connect <hostId | pairing link | code>
       doriface-host mesh pair | mesh join <mesh link | code> | mesh join --from-file <file>
       doriface-host mesh status [--json] | mesh revoke [--compromised] <member> | mesh rename <member> <name> | mesh leave
       doriface-host update [--channel stable|beta] | verify-release <SHA256SUMS.txt> <SHA256SUMS.txt.sig>
       doriface-host skill install [--dir <dir>]... | skill status [--json] | skill uninstall
       doriface-host resume-exec <launch file>   (typed into a terminal by the host to resume a program)

  --listen <host:port>  where to listen (default 127.0.0.1:7766, or any free port for a profile; loopback only)
  --hc <path>           the herdr-core binary (default hc)
  --install-hc          install (or update) herdr-core into ~/.local/bin from its checksummed release, then exit
  --session <name>      the hc session to reach (hc connect --session; a profile's default is doriterm-<profile>)
  --token <token>       the client token (default $DORIFACE_HOST_TOKEN, else 32 random bytes)
  --print-token         print the token on stdout once listening
  --unsafe-listen       allow a non-loopback --listen (plaintext: anyone who can reach it gets a shell)
  --lan-listen <h:p>    for tests: also serve the end-to-end encrypted /v1/e2ee (only) here; no shipped client dials it (#2070)
  --state-dir <dir>     host keys and paired devices (default $DORIFACE_HOST_STATE_DIR, else $XDG_STATE_HOME/doriface-host,
                        or $XDG_STATE_HOME/doriface-host-profiles/<profile>)
  --relay <url>         the relay this host keeps an encrypted-only uplink to (default ${DEFAULT_RELAY_URL})
  --local-only          run with no relay at all: only this computer reaches the host (the desktop app and terminals
                        here); pairing a device and joining or offering a mesh are refused. Not with --relay or --lan-listen
  --no-relay            for tests: keep no relay uplink, so only this computer and a --lan-listen test reach the host
  --auto-update <ch>    stable or beta: update this binary from get.doriterm.com's signed manifest and exit for the
                        service manager to restart it; off (the default) leaves updates to you
  --push-test-origin <origin>  for tests: also post web push notices to this push service origin (port 0: any port)
  --no-resume           bring no program back after a restart, and give terminals no OSC 7577 token
  --version             print this host's version
  -h, --help            show this help

  $DORITERM_PROFILE     run a separate host, in its own mesh, beside the default one: its own state dir, hc session and
                        port, for every command (1-32 lowercase letters, digits and inner dashes)`;
