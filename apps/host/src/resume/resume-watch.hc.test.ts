import { afterAll, describe, expect, test } from "bun:test";
import { HcConnection } from "@doriface/client";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHcLink } from "../mesh/hc-machines.ts";
import { meshProgram } from "../mesh/program.ts";
import { createHcSession, stopLeftoverCores } from "../testing/hc-session.ts";
import { ResumeStore } from "./records.ts";
import { type ResumeWatch, resumeWatch } from "./resume-watch.ts";
import { mintToken, TOKEN_VAR } from "./run-tokens.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "resume-watch-")));
const home = join(scratch, "home");
const work = join(scratch, "work");
mkdirSync(home);
mkdirSync(work);
// A variable only the shell's startup file sets: a resumed program that sees it ran after the startup files.
writeFileSync(join(home, ".bashrc"), "export FROM_RC=yes\nPS1='$ '\n");
const session = createHcSession("resume", { SHELL: "/bin/bash", HOME: home });
const core = { hc: session.hc, session: session.name, env: session.env };
const watches: ResumeWatch[] = [];
afterAll(async () => {
  await Promise.all(watches.map((each) => each.stop()));
  await session.dispose();
  await stopLeftoverCores();
  rmSync(scratch, { recursive: true, force: true });
});

/** The spec's own wrapper ("A wrapper to make any program resume"): reports for its pid, then becomes the program. */
const WRAP = join(scratch, "resume-wrap");
writeFileSync(
  WRAP,
  `#!/bin/sh
if [ -n "$OSC7577_TOKEN" ]; then
  args=$(for a in ${WRAP} "$@"; do printf '%s' "$a" | base64 | tr -d '\\n'; echo; done | paste -sd, -)
  body=$(printf 'pid=%s:time=%s:argv=%s' "$$" "$(date +%s)" "$args")
  mac=$(printf '%s:%s' "$body" "$OSC7577_TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64)
  printf '\\033]7577;%s:mac=%s\\033\\\\' "$body" "$mac" > /dev/tty
fi
unset OSC7577_TOKEN
exec "$@"
`,
  { mode: 0o755 },
);
/** The program resumed: writes where it runs, what the startup file set, and each argument it got, then waits. */
const RECORDER = join(scratch, "recorder");
writeFileSync(
  RECORDER,
  `#!/bin/sh
out=$1; shift
{ printf 'pwd=%s\\n' "$PWD"; printf 'rc=%s\\n' "$FROM_RC"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } > "$out.tmp"
mv "$out.tmp" "$out"
exec sleep 600
`,
  { mode: 0o755 },
);

/** Resolves once `check` holds, looking again on every change in `dir`; fails after `ms`. */
function until(dir: string, check: () => boolean, ms = 4_500): Promise<void> {
  if (check()) return Promise.resolve();
  const done = Promise.withResolvers<void>();
  const watcher = watch(dir, { recursive: true }, () => {
    if (check()) done.resolve();
  });
  const timer = setTimeout(() => done.reject(new Error(`not reached in ${ms} ms: ${check.toString()}`)), ms);
  return done.promise.finally(() => {
    clearTimeout(timer);
    watcher.close();
  });
}

let states = 0;
/** A watch over a fresh (or the given) state dir, with the addresses it watches and the lines it logged. */
function startWatch(stateDir = join(scratch, `state-${(states += 1)}`)) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logs: string[] = [];
  const watching = new Map<string, () => void>();
  const watched = new Set<string>();
  const instance = resumeWatch({
    core,
    stateDir,
    program: meshProgram(stateDir),
    shell: "/bin/bash",
    log: (line) => logs.push(line),
    sweepMs: 100,
    ownerExitGraceMs: 200,
    onWatching: (address) => {
      watched.add(address);
      watching.get(address)?.();
    },
  });
  watches.push(instance);
  const store = (): ResumeStore => ResumeStore.open(join(stateDir, "resume"));
  const isWatching = (address: string): Promise<void> => {
    if (watched.has(address)) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    watching.set(address, done.resolve);
    return done.promise;
  };
  return { instance, stateDir, logs, store, isWatching };
}

/** Starts a shell terminal with a token, as a client's run through the host does, and has `watch` watch it. */
async function tokenedShell(connection: HcConnection, watcher: ReturnType<typeof startWatch>, name: string) {
  const token = mintToken();
  const env = { TERM: "xterm-256color", [TOKEN_VAR]: token };
  const terminal = await connection.call("terminal.run", { name, cwd: work, env });
  watcher.instance.started({ address: terminal.address, token, name, env: { TERM: "xterm-256color" } });
  await watcher.isWatching(terminal.address);
  return { address: terminal.address, token };
}

const typeLine = (connection: HcConnection, terminal: string, words: readonly string[]) =>
  connection.call("terminal.send", { terminal, text: words.map((word) => `'${word}'`).join(" ") });

describe.skipIf(process.platform === "win32")("resumeWatch with a real core", () => {
  test("after a reboot the program comes back in the user's shell, its arguments unchanged, and reports again", async () => {
    const first = startWatch();
    let connection = await HcConnection.open(spawnHcLink(core));
    const shell = await tokenedShell(connection, first, "opened-resume1");
    const out = join(scratch, "resumed.txt");
    await typeLine(connection, shell.address, [WRAP, RECORDER, out, "$(touch pwned)", "a; b"]);
    await until(first.stateDir, () => first.store().entry(shell.address)?.record !== undefined);
    await until(scratch, () => existsSync(out));
    expect(first.store().entry(shell.address)?.record).toMatchObject({
      argv: [WRAP, RECORDER, out, "$(touch pwned)", "a; b"],
      cwd: work,
      firstProcess: false,
    });

    // The machine goes down: the host and the core stop, and the terminal with them.
    await first.instance.stop();
    rmSync(out);
    connection.close();
    // As the session's own stopCore does: the core closes this connection as it shuts down.
    const control = session.connect();
    await control.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n'));
    await control.reader.line();
    control.end();
    await control.exited;

    const second = startWatch(first.stateDir);
    await second.instance.ensure();
    await until(scratch, () => existsSync(out));
    expect(readFileSync(out, "utf8")).toBe(`pwd=${work}\nrc=yes\narg=$(touch pwned)\narg=a; b\n`);
    expect(existsSync(join(work, "pwned"))).toBe(false);

    // The old terminal's record was spent; the new terminal has its own token and the wrapper's fresh report.
    const store = second.store();
    expect(store.entry(shell.address)).toBeUndefined();
    const [resumed] = store.addresses();
    expect(resumed).toBeDefined();
    await until(second.stateDir, () => second.store().entry(resumed ?? "")?.record !== undefined);
    expect(second.store().entry(resumed ?? "")?.token).not.toBe(shell.token);
    connection = await HcConnection.open(spawnHcLink(core));
    const terminal = await connection.call("terminal.get", { terminal: resumed ?? "" });
    expect(terminal.argv).toEqual(["/bin/bash"]);
    expect(terminal.name).toBe("opened-resume1");
    expect(second.logs.join("\n")).toContain("resume: resumed");
    connection.close();
  });

  test("a record of another user, or one whose reported directory is gone, is spent and never runs", async () => {
    const stateDir = join(scratch, "seeded-state");
    const seeded = ResumeStore.open(join(stateDir, "resume"));
    const out = join(scratch, "never.txt");
    const record = {
      argv: [RECORDER, out],
      cwd: work,
      cwdReported: false,
      pid: 4242,
      started: "x",
      firstProcess: false,
      time: 1,
      uid: process.getuid?.() ?? 0,
    };
    seeded.track("gone-1", { token: mintToken(), name: null, env: {} });
    seeded.accept("gone-1", { ...record, uid: record.uid + 1 });
    seeded.track("gone-2", { token: mintToken(), name: null, env: {} });
    seeded.accept("gone-2", { ...record, cwd: join(scratch, "deleted"), cwdReported: true });
    const watcher = startWatch(stateDir);
    const connection = await HcConnection.open(spawnHcLink(core));
    const before = (await connection.call("terminal.list", { all: true })).terminals.length;
    await watcher.instance.ensure();
    expect(watcher.store().addresses()).toEqual([]);
    expect((await connection.call("terminal.list", { all: true })).terminals.length).toBe(before);
    expect(watcher.logs.filter((line) => line.includes("not resuming"))).toHaveLength(2);
    expect(existsSync(out)).toBe(false);
    connection.close();
  });

  test("a record that was its terminal's first process comes back as the first process, after the shell's startup", async () => {
    const stateDir = join(scratch, "first-state");
    const seeded = ResumeStore.open(join(stateDir, "resume"));
    const out = join(scratch, "first.txt");
    seeded.track("gone-3", { token: mintToken(), name: null, env: {} });
    seeded.accept("gone-3", {
      argv: [RECORDER, out, "x y"],
      cwd: work,
      cwdReported: true,
      pid: 4243,
      started: "x",
      firstProcess: true,
      time: 1,
      uid: process.getuid?.() ?? 0,
    });
    const watcher = startWatch(stateDir);
    await watcher.instance.ensure();
    await until(scratch, () => existsSync(out));
    expect(readFileSync(out, "utf8")).toBe(`pwd=${work}\nrc=yes\narg=x y\n`);
    const [resumed = ""] = watcher.store().addresses();
    const connection = await HcConnection.open(spawnHcLink(core));
    const terminal = await connection.call("terminal.get", { terminal: resumed });
    expect(terminal.argv.slice(1, 3)).toEqual(["-i", "-c"]);
    connection.close();
  });

  test("an owner that exits while its terminal lives on leaves nothing; a terminal that ends for good is forgotten", async () => {
    const watcher = startWatch();
    await watcher.instance.ensure();
    const connection = await HcConnection.open(spawnHcLink(core));
    const shell = await tokenedShell(connection, watcher, "opened-resume3");
    await typeLine(connection, shell.address, [WRAP, "sleep", "1"]);
    await until(watcher.stateDir, () => watcher.store().entry(shell.address)?.record !== undefined);
    await until(watcher.stateDir, () => watcher.store().entry(shell.address)?.record === undefined);
    expect(watcher.store().entry(shell.address)).toBeDefined();
    await connection.call("terminal.send", { terminal: shell.address, text: "exit 0" });
    await until(watcher.stateDir, () => watcher.store().entry(shell.address) === undefined);
    connection.close();
  });
});
