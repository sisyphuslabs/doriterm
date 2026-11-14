// A second hc core added to the e2e core with `hc machine add --via`. Its dial reads a switch file, so a spec can turn
// the machine off (the dial fails) or make it ask for a login (the dial prints ssh's refusal) with the page open.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_MACHINE_DIR } from "./config.ts";

export const MACHINE_NAME = "build-box";
/** Holds `off` or `login`, or `slow` for a dial that answers late; absent means the machine answers. */
export const MACHINE_SWITCH = join(E2E_MACHINE_DIR, "switch");
/** The second core's environment, so a spec can stop that core. */
export const MACHINE_ENV = join(E2E_MACHINE_DIR, "env.json");
/** One line per dial: the pids of the processes carrying hc's lines to the second core, so a spec can drop them all. */
export const MACHINE_LINE_PID = join(E2E_MACHINE_DIR, "line.pid");
/** One line per `slow` dial, written before it sleeps: its pid, so a spec can tell a dial is still on its way. */
export const MACHINE_DIALING = join(E2E_MACHINE_DIR, "dialing");

const agent = (state: string, msg: string, line: string): string[] => [
  "sh",
  "-c",
  `printf '\\033]7501;state=${state}:msg=${btoa(msg)}\\033\\\\'; printf '%s\\n' '${line}'; exec sleep 3600`,
];

/** One demo terminal: `hc run` arguments before `--`, then its program. */
export interface Seed {
  readonly args: readonly string[];
  readonly argv: readonly string[];
}

/** The machine a host adds: its name, where its switch and state live, and its demo terminals. */
export interface MachineSpec {
  readonly name: string;
  readonly dir: string;
  readonly seeds: readonly Seed[];
}

export const DEMO_MACHINE: MachineSpec = {
  name: MACHINE_NAME,
  dir: E2E_MACHINE_DIR,
  // Both terminals sit in `infra`, and its label names the space the sidebar lists them under, as on this machine.
  seeds: [
    {
      args: ["--name", "plan", "--label", "space=infra"],
      argv: agent("working", "terraform plan", "Refreshing state"),
    },
    { args: ["--name", "logs", "--label", "space=infra"], argv: ["env", "PS1=$ ", "sh"] },
  ],
};

/**
 * The `--via` command: refuses as the switch says, else runs hc's line against the second core. `slow` holds a dial past
 * the switch for a moment before its line starts, as a dial on a loaded runner is, and records its pid in `dialing` first.
 */
export function viaCommand(own: Readonly<Record<string, string>>, spec: MachineSpec): string {
  const env = Object.entries(own)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  const refusals = [
    // The machine's stop removes its dir first: a dial that comes after (a line its dialing core started before it
    // stopped) is refused, since its hc connect would start the stopped core again with nothing left to stop it (#2142).
    `[ -d "${spec.dir}" ] || { echo "${spec.name} is stopped" >&2; exit 1; }`,
    `m=$(cat "${join(spec.dir, "switch")}" 2>/dev/null)`,
    `[ "$m" = off ] && { echo "${spec.name} is switched off" >&2; exit 1; }`,
    `[ "$m" = login ] && { echo "Permission denied (publickey,password)." >&2; exit 255; }`,
    // A held dial checks again once it wakes: the machine may have stopped while it slept (#2158).
    `[ "$m" = slow ] && { echo $$ >> "${join(spec.dir, "dialing")}"; sleep 10; [ -d "${spec.dir}" ] || { echo "${spec.name} is stopped" >&2; exit 1; }; }`,
  ];
  return `sh -c '${refusals.join("; ")}; echo $$ >> "${MACHINE_LINE_PID}"; exec env ${env} sh -c "$1"' sh`;
}

/** Starts each seed with `hc run --bg` in `cwd`. */
export async function runSeeds(
  hc: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  seeds: readonly Seed[],
): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  for (const { args, argv } of seeds) {
    const run = Bun.spawn([hc, "run", "--bg", ...args, "--", ...argv], { env, cwd, stdout: "ignore" });
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the start order is the terminal order
    if ((await run.exited) !== 0) throw new Error(`hc run ${args.join(" ")} failed`);
  }
}

const SEEDS_LISTED_WITHIN_MS = 60_000;

/** How many live terminals the core in `env` lists on the machine named `name`. */
async function listedOn(hc: string, env: Record<string, string | undefined>, name: string): Promise<number> {
  const ls = Bun.spawn([hc, "ls", "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, code] = [await new Response(ls.stdout).text(), await ls.exited];
  if (code !== 0) throw new Error(`hc ls failed: ${await new Response(ls.stderr).text()}`);
  const terminals: unknown = Reflect.get(JSON.parse(out), "terminals");
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.filter((t: unknown) => String(Reflect.get(Object(t), "address")).startsWith(`${name}/`)).length;
}

/**
 * Resolves once the core in `env` lists every seed of the machine it added. The added machine's terminals reach that
 * core through its machine list, after `hc machine add` has returned, and hc gives no word when they have: the list is
 * read again until they are all there, or the bound runs out and setup fails.
 */
async function seedsListed(hc: string, env: Record<string, string | undefined>, spec: MachineSpec): Promise<void> {
  const deadline = Date.now() + SEEDS_LISTED_WITHIN_MS;
  // oxlint-disable-next-line no-await-in-loop -- each read waits on hc; the next one only if the seeds are not all there
  while ((await listedOn(hc, env, spec.name)) < spec.seeds.length) {
    if (Date.now() > deadline) throw new Error(`${spec.name}'s ${spec.seeds.length} seeds were not listed in time`);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await Bun.sleep(100);
  }
}

/** How long a core told to stop may take to exit; past it the stop throws, naming the process. */
const CORE_EXIT_BOUND_MS = 20_000;

/** Whether a process with that pid is running (one owned by another user counts: it is there). */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

/**
 * The `pid` of the reply with `id` in hc connect's output (one JSON-RPC reply per line); undefined when it has none.
 * A line that is not JSON (hc's own words on a failed connect) is no reply and is passed over.
 */
export function replyPid(output: string, id: number): number | undefined {
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      continue;
    }
    if (Reflect.get(Object(reply), "id") !== id) continue;
    const pid: unknown = Reflect.get(Object(Reflect.get(Object(reply), "result")), "pid");
    return typeof pid === "number" ? pid : undefined;
  }
  return undefined;
}

/**
 * Resolves once `pid` has exited. hc answers server.stop before its core has exited, and a core that is not this
 * process's child gives no exit event, so the process table is asked until it is gone or the bound runs out (#2525).
 */
async function exitOf(pid: number, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (running(pid)) {
    if (Date.now() > deadline) {
      // Killed before the throw, so a teardown that stops at the error leaves no core behind it (#2527 review).
      process.kill(pid, "SIGKILL");
      throw new Error(`the machine's core (pid ${pid}) did not exit within ${withinMs} ms, so it was killed`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one look at the process table per round, until the core is gone
    await Bun.sleep(25);
  }
}

/** Starts the second core (with its demo terminals when `withSeeds`) and adds it; resolves with its stop. */
export async function addMachine(
  hc: string,
  env: Record<string, string | undefined>,
  root: string,
  withSeeds: boolean,
  spec: MachineSpec = DEMO_MACHINE,
): Promise<() => Promise<void>> {
  const session = `web-e2e-b-${crypto.randomUUID().slice(0, 8)}`;
  const own = {
    HC_SESSION: session,
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HC_SOCKET: join(root, "c.sock"),
    PATH: `${dirname(hc)}:${env["PATH"] ?? "/usr/bin:/bin"}`,
  };
  const coreDir = join(own.XDG_STATE_HOME, "herdr-core", session);
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(
    join(coreDir, "core.json"),
    JSON.stringify({ id: crypto.randomUUID().replace(/-/g, ""), name: "build" }),
  );
  rmSync(spec.dir, { recursive: true, force: true });
  mkdirSync(spec.dir, { recursive: true });
  const there = { ...env, ...own };
  const stop = async (): Promise<void> => {
    rmSync(spec.dir, { recursive: true, force: true });
    const control = Bun.spawn([hc, "connect", "--session", session], { env: there, stdin: "pipe", stdout: "pipe" });
    // Read while it runs, so a stopping core can never wait on a full pipe; the status reply names the core's pid.
    const replies = new Response(control.stdout).text();
    control.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"server.status"}\n{"jsonrpc":"2.0","id":2,"method":"server.stop"}\n',
    );
    await control.stdin.flush();
    void control.stdin.end();
    await control.exited;
    // The stop resolves once the core has exited, not once it has answered: a check right after it, or a dial that
    // follows, then never meets a core still on its way out (#2525).
    const output = await replies;
    const pid = replyPid(output, 1);
    // hc connect starts a core that is not running, so a status reply without a pid is a failed call, not a missing core.
    if (pid === undefined)
      throw new Error(`the machine's core did not name its pid, so its exit cannot be awaited: ${output}`);
    await exitOf(pid, CORE_EXIT_BOUND_MS);
  };
  try {
    writeFileSync(join(spec.dir, "env.json"), JSON.stringify({ hc, env: own }));
    if (withSeeds) await runSeeds(hc, there, join(root, "infra"), spec.seeds);
    const add = Bun.spawn([hc, "machine", "add", "--via", viaCommand(own, spec), "--name", spec.name], {
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    // Read while it runs: hc can write more to stderr than a pipe holds on a slow dial, and a full pipe would block the
    // add for good, with nothing on stdout to say where it stopped (#502).
    const said = new Response(add.stderr).text();
    const code = await add.exited;
    const why = await said;
    if (code !== 0) throw new Error(`hc machine add for the second core failed (exit ${code}): ${why}`);
    if (withSeeds) await seedsListed(hc, env, spec);
  } catch (error) {
    try {
      await stop();
    } catch (stopError) {
      // The setup's error stays first in the list: it is what went wrong; the stop's failure is kept beside it (#2527 review).
      throw new AggregateError(
        [error, stopError],
        `the second core's setup failed, and so did its stop: ${String(error)}`,
        {
          cause: stopError,
        },
      );
    }
    throw error;
  }
  return stop;
}
