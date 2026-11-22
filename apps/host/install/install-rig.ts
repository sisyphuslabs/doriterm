// The installer's test rig: a HOME, a file:// release with a fake doriface-host, and stubs for the service managers.
import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRIPT = join(import.meta.dir, "install.sh");

// The name install.sh uses (`id -un`); userInfo() reads $USER first and answers "unknown" where it is unset (#2476).
export const USER = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();

export interface Rig {
  readonly root: string;
  readonly home: string;
  readonly release: string;
  readonly stubs: string;
  readonly log: string;
}

const rigs: string[] = [];
/** Removes every rig made since the last call; each test file runs it after each test. */
export function removeRigs(): void {
  for (const dir of rigs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const stub = (dir: string, name: string, body: string): void => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

/**
 * A launchd that remembers whether the agent is loaded: bootout unloads it, print finds it only while it is loaded, and
 * bootstrap loads it, except that the first `failures` bootstraps fail with 5 (EIO), as launchd's do for a while after
 * an agent it is still unloading has already left `print` (#1966).
 */
export function launchd(dir: string, log: string, failures = 0): string {
  const state = join(dir, "launchd-state");
  const left = join(dir, "launchd-failures");
  writeFileSync(state, "gone");
  writeFileSync(left, String(failures));
  stub(
    dir,
    "launchctl",
    [
      `echo "launchctl $*" >> "${log}"`,
      `case "$1" in`,
      `  bootout) echo gone > "${state}" ;;`,
      `  print) [ "$(cat "${state}")" = loaded ] || exit 113 ;;`,
      `  bootstrap) n=$(cat "${left}"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${left}"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; echo loaded > "${state}" ;;`,
      `esac`,
    ].join("\n"),
  );
  return state;
}

/**
 * A logind that remembers whether the user lingers: `show-user` answers it, and `enable-linger` turns it on when the
 * system grants that to the user, or fails as it does where an admin has to do it.
 */
export function lingering(dir: string, log: string, linger: "yes" | "no", enable: "granted" | "refused"): void {
  const state = join(dir, "linger-state");
  writeFileSync(state, linger);
  stub(
    dir,
    "loginctl",
    [
      `case "$*" in`,
      `  *show-user*) cat "${state}" ;;`,
      `  *enable-linger*) echo "loginctl $*" >> "${log}"; ${enable === "granted" ? `printf yes > "${state}"` : "exit 1"} ;;`,
      `esac`,
    ].join("\n"),
  );
}

export const enabledLinger = (calls: readonly string[]): string[] =>
  calls.filter((call) => call.startsWith("loginctl"));

export const sha256 = (bytes: string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * A HOME, a file:// release holding a fake doriface-host and its SHA256SUMS.txt, and stubs for uname and the service
 * managers that append every call to one log, so a test reads what the installer did in order.
 */
export function rig(system: "Linux" | "Darwin", machine = "x86_64"): Rig {
  const root = mkdtempSync(join(tmpdir(), "df-install-"));
  rigs.push(root);
  const home = join(root, "home");
  const release = join(root, "release");
  const stubs = join(root, "stubs");
  const log = join(root, "calls.log");
  for (const dir of [home, release, stubs]) mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  stub(stubs, "uname", `[ "$1" = -s ] && echo ${system} || echo ${machine}`);
  stub(stubs, "systemctl", `echo "systemctl $*" >> "${log}"`);
  // The user lingers already, so no test reaches the real loginctl and changes the machine it runs on.
  lingering(stubs, log, "yes", "granted");
  // No agent is loaded yet, as on a computer that never ran the host.
  launchd(stubs, log);
  const os = system === "Linux" ? "linux" : "mac";
  const arch = machine === "x86_64" ? "x64" : "arm64";
  const host = [
    "#!/bin/sh",
    `echo "doriface-host $*" >> "${log}"`,
    `if [ "$1" = --install-hc ]; then mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho 0.1.17\\n' > "$HOME/.local/bin/hc"; chmod 755 "$HOME/.local/bin/hc"; fi`,
    `if [ "$1" = pair ]; then echo "doriface://pair#h=fake"; fi`,
    // A test that writes `help` gets a host whose --help names those commands; `skill-exit` sets how `skill` exits.
    `if [ "$1" = --help ]; then cat "${root}/help" 2>/dev/null; fi`,
    `if [ "$1" = skill ]; then exit "$(cat "${root}/skill-exit" 2>/dev/null || echo 0)"; fi`,
    // What mesh join read from --from-file, and the file's mode, as the host saw them while it ran.
    `prev=""; for a in "$@"; do if [ "$prev" = --from-file ]; then echo "from-file $(cat "$a") $(stat -c %a "$a" 2>/dev/null || stat -f %Lp "$a")" >> "${log}"; fi; prev="$a"; done`,
    "",
  ].join("\n");
  const asset = `doriface-host-${os}-${arch}`;
  writeFileSync(join(release, asset), host);
  writeFileSync(join(release, "SHA256SUMS.txt"), `${sha256(host)}  ${asset}\n${"0".repeat(64)}  other.zip\n`);
  return { root, home, release, stubs, log };
}

export function install(
  r: Rig,
  args: readonly string[] = [],
  extraPath: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
  cwd?: string,
) {
  const proc = Bun.spawnSync(["/bin/sh", SCRIPT, "--from", `file://${r.release}`, ...args], {
    cwd,
    env: {
      HOME: r.home,
      PATH: [r.stubs, ...extraPath, "/usr/bin", "/bin"].join(":"),
      SHELL: "/bin/zsh",
      TMPDIR: r.root,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls: readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean),
  };
}

export const LINK = "doriface://pair#h=a&m=1";

/**
 * The installer ran `mesh join` with the link in a file this user alone can read, and never with the link on any
 * command line, where other local users can read it (#1201); the spent file is gone once the installer exits.
 */
export function expectJoinedFromFile(calls: readonly string[], command: string): void {
  const joinCall = calls.find((call) => call.startsWith(command));
  expect(joinCall).toBeDefined();
  const file = (joinCall ?? "").slice(command.length);
  expect(calls).toContain(`from-file ${LINK} 600`);
  expect(calls.filter((call) => call.startsWith("doriface-host") && call.includes(LINK))).toEqual([]);
  expect(existsSync(file)).toBe(false);
}
