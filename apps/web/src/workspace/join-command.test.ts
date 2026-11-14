import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_SCRIPT_URL, joinCommand, offerFor } from "./join-command.ts";

const INSTALL_SH = join(import.meta.dir, "../../../host/install/install.sh");

const stub = (dir: string, name: string, body: string): void => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the line the dialog hands out the way a person's shell would, against this repository's install.sh, a file://
 * release holding a fake doriface-host, and a PATH on which every command is a wrapper that logs its name and arguments
 * before running the real one, so the log holds every external process the line starts (curl, sh, uname and systemctl are
 * stubbed outright).
 */
function runJoinLine(link: string): readonly string[] {
  const root = mkdtempSync(join(tmpdir(), "df-join-line-"));
  dirs.push(root);
  const home = join(root, "home");
  const release = join(root, "release");
  const stubs = join(root, "stubs");
  for (const dir of [home, release, stubs]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  // curl hands the install.sh URL this repository's script, and fetches everything else (the file:// release) for real.
  stub(
    stubs,
    "curl",
    `echo "curl $*" >> "${log}"; for a in "$@"; do [ "$a" = "${INSTALL_SCRIPT_URL}" ] && exec cat "${INSTALL_SH}"; done; exec /usr/bin/curl "$@"`,
  );
  // The shell the line pipes the installer into, as the person's PATH finds it: its arguments are a command line too.
  stub(stubs, "sh", `echo "sh $*" >> "${log}"; exec /bin/sh "$@"`);
  stub(stubs, "uname", `[ "$1" = -s ] && echo Linux || echo x86_64`);
  stub(stubs, "systemctl", `echo "systemctl $*" >> "${log}"`);
  // Every other command on PATH logs itself, then runs the real one: the log covers all of install.sh's external commands.
  stub(
    stubs,
    ".logged",
    `n=\${0##*/}; echo "$n $*" >> "${log}"; for d in /usr/bin /bin; do [ -x "$d/$n" ] && exec "$d/$n" "$@"; done; exit 127`,
  );
  for (const dir of ["/usr/bin", "/bin"]) {
    for (const name of readdirSync(dir)) {
      if (!existsSync(join(stubs, name))) symlinkSync(join(stubs, ".logged"), join(stubs, name));
    }
  }
  const host = [
    "#!/bin/sh",
    `echo "doriface-host $*" >> "${log}"`,
    `if [ "$1" = --install-hc ]; then mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho 0.1.17\\n' > "$HOME/.local/bin/hc"; chmod 755 "$HOME/.local/bin/hc"; fi`,
    `prev=""; for a in "$@"; do [ "$prev" = --from-file ] && echo "from-file $(cat "$a")" >> "${log}"; prev="$a"; done`,
    "",
  ].join("\n");
  writeFileSync(join(release, "doriface-host-linux-x64"), host);
  const sum = new Bun.CryptoHasher("sha256").update(host).digest("hex");
  writeFileSync(join(release, "SHA256SUMS.txt"), `${sum}  doriface-host-linux-x64\n`);
  const run = Bun.spawnSync(["/bin/sh", "-c", joinCommand(link)], {
    env: {
      HOME: home,
      PATH: stubs,
      TMPDIR: root,
      DORIFACE_RELEASE_BASE: `file://${release}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  return readFileSync(log, "utf8").trim().split("\n");
}

describe("join command", () => {
  test("is one line: the installer, handed the link in its environment, quoted for sh", () => {
    expect(joinCommand("doriface://pair#h=a&k=b&m=1")).toBe(
      `curl -fsSL ${INSTALL_SCRIPT_URL} | DORIFACE_JOIN='doriface://pair#h=a&k=b&m=1' sh`,
    );
    // A quote in a link cannot end the value early.
    expect(joinCommand("x'y")).toBe(`curl -fsSL ${INSTALL_SCRIPT_URL} | DORIFACE_JOIN='x'\\''y' sh`);
  });

  test("run as handed out, it joins through install.sh, and no process it starts has the link on its command line (#1626)", () => {
    const link = "doriface://pair#h=a&k=b&m=1";
    const calls = runJoinLine(link);
    // install.sh read the link from DORIFACE_JOIN and handed mesh join a file holding it, instead of printing a pairing.
    expect(calls.some((call) => call.startsWith("doriface-host mesh join ") && call.includes(" --from-file "))).toBe(
      true,
    );
    expect(calls).toContain(`from-file ${link}`);
    expect(calls.some((call) => call.startsWith("doriface-host pair"))).toBe(false);
    // No process the line started has the link on its command line. The log holds every external command (the installer's
    // own helpers such as mktemp and sha256sum included), not only the stubbed ones. (Children do inherit DORIFACE_JOIN in
    // their environment, which only the same user and root can read.)
    expect(calls.some((call) => call.startsWith("sh"))).toBe(true);
    expect(calls.some((call) => call.startsWith("mktemp "))).toBe(true);
    expect(calls.filter((call) => !call.startsWith("from-file ") && call.includes(link))).toEqual([]);
    // One run spawns install.sh and every helper it calls, as install.test.ts's cases do: 15 s, the measure #2488 took for
    // those, instead of bun's 5 s default, which a loaded runner exceeds on every run.
  }, 15_000);

  test("reads only the answer to this request", () => {
    expect(offerFor({ request: "r1" }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r0", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r1", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toEqual({
      phase: "ready",
      link: "doriface://pair#a",
      command: joinCommand("doriface://pair#a"),
      expiresAt: 5,
    });
    expect(offerFor({ request: "r1", error: "the mesh is full" }, "r1")).toEqual({
      phase: "failed",
      reason: "the mesh is full",
    });
    expect(offerFor({ request: "r1", expired: true }, "r1")).toEqual({ phase: "expired" });
    expect(offerFor({ request: "r1", joined: { name: "laptop", hostId: "h2" } }, "r1")).toEqual({
      phase: "joined",
      name: "laptop",
    });
    expect(offerFor(null, "r1")).toBeUndefined();
  });
});
