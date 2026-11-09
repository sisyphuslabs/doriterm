import { HcConnection } from "@doriface/client";
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessLink } from "@doriface/client/process-link";
import { createHcSession, type HcSession } from "../../../../apps/host/src/testing/hc-session.ts";
import { ownMeshSession } from "../../../../apps/host/src/testing/mesh-session.ts";
import { Matches } from "../watch.ts";
import type { Owned } from "./processes.ts";
import type { Tap } from "./relay-front.ts";

const CLI = join(import.meta.dir, "..", "..", "..", "..", "apps", "host", "src", "cli.ts");
const UPLINK_MS = 60_000;
const STOP_MS = 15_000;
const HOST_LINE = /host (\w+), fingerprint/;

export interface CliResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One doriface-host process with its own state dir and its own hc core, dialing the relay through its own tap. */
export interface MeshHost {
  readonly name: string;
  readonly hostId: string;
  readonly stateDir: string;
  readonly session: HcSession;
  /** The hc session's own directory, where its core keeps its sockets. */
  readonly sessionDir: string;
  readonly tap: Tap | undefined;
  readonly logs: readonly string[];
  /** The host process now; a restart gives a new one. */
  pid(): number;
  /** Runs `doriface-host <args> --state-dir <this host's>`; the mesh subcommands reach the running host from there. */
  cli(...args: string[]): Promise<CliResult>;
  /** An hc connection straight to this host's own core. */
  core(): Promise<HcConnection>;
  /** Resolves on the next log line matching `pattern` that arrives after this call. */
  nextLog(pattern: RegExp, what: string, ms?: number): Promise<string>;
  /** Calls `wake` on every log line and every write in its state dir, until the returned function is called. */
  onActivity(wake: () => void): () => void;
  /** Stops the host process and keeps its state dir, so `start` brings the same host back. */
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Every process this host started, by kind, for the teardown receipt. */
  owned(): readonly Owned[];
  dispose(): Promise<void>;
}

export interface MeshHostOptions {
  readonly name: string;
  readonly relayUrl: string;
  readonly tap?: Tap | undefined;
  /** What its hc core calls itself, instead of this machine's hostname: a capture then shows no real host. */
  readonly coreName?: string | undefined;
}

/** Ends a child the host's own teardown no longer needs, and waits until it is gone. */
async function reap(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  await child.exited;
  clearTimeout(timer);
}

async function textOf(stream: ReadableStream<Uint8Array>, each: (chunk: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) each(decoder.decode(chunk, { stream: true }));
}

export async function startMeshHost(options: MeshHostOptions): Promise<MeshHost> {
  const { name, relayUrl, tap, coreName } = options;
  const scratch = mkdtempSync(join(tmpdir(), `mh-${name}-`));
  const stateDir = join(scratch, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const scratchSession = createHcSession(`doriface-mesh-${name}`);
  if (coreName !== undefined) {
    const coreDir = join(scratchSession.env["XDG_STATE_HOME"] ?? "", "herdr-core", scratchSession.name);
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(
      join(coreDir, "core.json"),
      JSON.stringify({ id: crypto.randomUUID().replaceAll("-", ""), name: coreName }),
    );
  }
  const session = await ownMeshSession(scratchSession);
  const sessionDir = dirname(session.env["HC_SOCKET"] ?? "");
  const logs: string[] = [];
  const lines = new Matches<string>();
  const wakes = new Set<() => void>();
  const owned: Owned[] = [];
  const children: Bun.Subprocess[] = [];
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const wakeAll = (): void => {
    for (const wake of wakes) wake();
  };
  const onText = (text: string): void => {
    for (const line of text.split("\n").filter((entry) => entry !== "")) {
      logs.push(line);
      lines.push(line);
      wakeAll();
    }
  };
  const stateWrites = watch(stateDir, wakeAll);
  const start = async (): Promise<void> => {
    const from = lines.seen.length;
    const connected = lines.next(
      (line) => lines.seen.indexOf(line, from) >= from && line.includes("relay: connected"),
      `${name}'s relay uplink`,
      UPLINK_MS,
    );
    const argv = ["--listen", "127.0.0.1:0", "--state-dir", stateDir, "--relay", relayUrl];
    const started = Bun.spawn([process.execPath, CLI, ...argv, "--hc", session.hc, "--session", session.name], {
      cwd: scratch,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: session.env,
    });
    proc = started;
    owned.push({ kind: "host", pid: started.pid });
    void textOf(started.stderr, onText);
    void textOf(started.stdout, onText);
    await connected;
  };
  const stop = async (): Promise<void> => {
    const running = proc;
    proc = undefined;
    if (running === undefined) return;
    running.kill("SIGTERM");
    const timer = setTimeout(() => running.kill("SIGKILL"), STOP_MS);
    await running.exited;
    clearTimeout(timer);
  };
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    stateWrites.close();
    await stop();
    await Promise.all(children.map((child) => reap(child)));
    try {
      await session.dispose();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const spawnOwned = (kind: Owned["kind"], argv: readonly string[]): Bun.Subprocess<"pipe", "pipe", "pipe"> => {
    const child = Bun.spawn([...argv], {
      cwd: scratch,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: session.env,
    });
    owned.push({ kind, pid: child.pid });
    children.push(child);
    return child;
  };
  try {
    await start();
    const hostId = logs.map((line) => HOST_LINE.exec(line)?.[1]).find((id) => id !== undefined);
    if (hostId === undefined) throw new Error(`${name} never logged its host id:\n${logs.join("\n")}`);
    return {
      name,
      hostId,
      stateDir,
      session,
      sessionDir,
      tap,
      logs,
      pid: () => proc?.pid ?? -1,
      async cli(...args) {
        const run = spawnOwned("cli", [process.execPath, CLI, ...args, "--state-dir", stateDir]);
        void run.stdin.end();
        const [stdout, stderr, exit] = await Promise.all([
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
          run.exited,
        ]);
        return { exit, stdout, stderr };
      },
      core: () =>
        HcConnection.open(
          new ProcessLink(spawnOwned("hc-connect", [session.hc, "connect", "--session", session.name])),
        ),
      nextLog(pattern, what, ms) {
        const seen = lines.seen.length;
        return lines.next((line) => lines.seen.indexOf(line, seen) >= seen && pattern.test(line), what, ms);
      },
      onActivity(wake) {
        wakes.add(wake);
        return () => wakes.delete(wake);
      },
      stop,
      start,
      owned: () => owned,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
