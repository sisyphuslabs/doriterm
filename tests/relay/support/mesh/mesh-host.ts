import { HcConnection } from "@doriface/client";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessLink } from "../../../../packages/client/src/testing/process-link.ts";
import { createHcSession, type HcSession } from "../../../../apps/host/src/testing/hc-session.ts";
import { Matches, within } from "../watch.ts";
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
  readonly pid: number;
  readonly hostId: string;
  readonly stateDir: string;
  readonly session: HcSession;
  readonly tap: Tap | undefined;
  readonly logs: readonly string[];
  /** Runs `doriface-host <args> --state-dir <this host's>`; the mesh subcommands reach the running host from there. */
  cli(...args: string[]): Promise<CliResult>;
  /** How many times `cli` ran on this host: the count of operator steps taken here. */
  cliCalls(): number;
  /** An hc connection straight to this host's own core. */
  core(): Promise<HcConnection>;
  /** Resolves on the next log line matching `pattern` that arrives after this call. */
  nextLog(pattern: RegExp, what: string, ms?: number): Promise<string>;
  /** Calls `wake` on every log line, until the returned function is called. */
  onLog(wake: () => void): () => void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface MeshHostOptions {
  readonly name: string;
  readonly relayUrl: string;
  readonly tap?: Tap | undefined;
}

async function textOf(stream: ReadableStream<Uint8Array>, each: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    each(text);
  }
  return all;
}

export async function startMeshHost(options: MeshHostOptions): Promise<MeshHost> {
  const { name, relayUrl, tap } = options;
  const scratch = mkdtempSync(join(tmpdir(), `mh-${name}-`));
  const stateDir = join(scratch, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const session = createHcSession(`doriface-mesh-${name}`);
  const logs: string[] = [];
  const lines = new Matches<string>();
  const wakes = new Set<() => void>();
  const connected = Promise.withResolvers<void>();
  let calls = 0;
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI,
      "--listen",
      "127.0.0.1:0",
      "--state-dir",
      stateDir,
      "--relay",
      relayUrl,
      "--hc",
      session.hc,
      "--session",
      session.name,
    ],
    { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: session.env },
  );
  const onText = (text: string): void => {
    for (const line of text.split("\n").filter((entry) => entry !== "")) {
      logs.push(line);
      lines.push(line);
      if (line.includes("relay: connected")) connected.resolve();
      for (const wake of wakes) wake();
    }
  };
  void textOf(proc.stderr, onText);
  void textOf(proc.stdout, onText);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), STOP_MS);
    await proc.exited;
    clearTimeout(timer);
    await session.dispose();
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    await within(connected.promise, `${name}'s relay uplink`, UPLINK_MS);
    const hostId = logs.map((line) => HOST_LINE.exec(line)?.[1]).find((id) => id !== undefined);
    if (hostId === undefined) throw new Error(`${name} never logged its host id:\n${logs.join("\n")}`);
    return {
      name,
      pid: proc.pid,
      hostId,
      stateDir,
      session,
      tap,
      logs,
      cliCalls: () => calls,
      async cli(...args) {
        calls += 1;
        const run = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", stateDir], {
          cwd: scratch,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: session.env,
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
          run.exited,
        ]);
        return { exit, stdout, stderr };
      },
      core() {
        const link = Bun.spawn([session.hc, "connect", "--session", session.name], {
          env: session.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        return HcConnection.open(new ProcessLink(link));
      },
      nextLog(pattern, what, ms) {
        const seen = lines.seen.length;
        return lines.next((line) => lines.seen.indexOf(line, seen) >= seen && pattern.test(line), what, ms);
      },
      onLog(wake) {
        wakes.add(wake);
        return () => wakes.delete(wake);
      },
      async stop() {
        await dispose();
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
