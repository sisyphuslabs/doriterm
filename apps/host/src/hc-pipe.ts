import type { Subprocess } from "bun";
import type { DataHandler, Link } from "./link.ts";
import { errnoOf, StartupError } from "./startup-error.ts";

export interface HcPipeOptions {
  readonly hc: string;
  readonly session?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly log: (line: string) => void;
}

/**
 * How long a closed pipe's `hc connect` has to hand the core what it was already sent before it is killed: it exits on
 * its own once stdin ends and it has forwarded the rest (#580); this bounds one that does not.
 */
export const DRAIN_GRACE_MS = 2_000;

/** One `hc connect` child as a Link: stdin and stdout carry the core's bytes, stderr goes to the log. */
export class HcPipe implements Link {
  readonly exited: Promise<number>;
  readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
  readonly #log: (line: string) => void;
  readonly #closeHandlers: (() => void)[] = [];
  #reading = false;
  #closed = false;

  constructor(options: HcPipeOptions) {
    const session = options.session === undefined ? [] : ["--session", options.session];
    this.#log = options.log;
    this.#proc = Bun.spawn([options.hc, "connect", ...session], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: options.env ?? process.env,
    });
    this.exited = this.#proc.exited;
    this.#pumpLog().catch((error: unknown) => this.#log(`hc connect[${this.pid}] stderr: ${String(error)}`));
  }

  get pid(): number {
    return this.#proc.pid;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("hc connect pipe is closed");
    this.#proc.stdin.write(bytes);
    await this.#proc.stdin.flush();
  }

  onData(handler: DataHandler): void {
    if (this.#reading) throw new Error("hc connect pipe already has a data handler");
    this.#reading = true;
    this.#pumpStdout(handler)
      .catch((error: unknown) => this.#log(`hc connect[${this.pid}] stdout: ${String(error)}`))
      .finally(() => this.close());
  }

  onClose(handler: () => void): void {
    if (this.#closed) handler();
    else this.#closeHandlers.push(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Ends stdin and lets the child exit by itself: killed at once, a request it had not yet handed the core was lost, as
    // an End's mark and kill are when the page that asked closes right after (#580). Signals this child only; the core
    // it attached to lives outside this process tree and keeps running.
    const grace = setTimeout(() => this.#proc.kill(), DRAIN_GRACE_MS);
    void this.#proc.exited.then(() => clearTimeout(grace));
    Promise.resolve()
      .then(() => this.#proc.stdin.end())
      .catch((error: unknown) => {
        this.#log(`hc connect[${this.pid}] stdin: ${String(error)}`);
        this.#proc.kill();
      });
    for (const handler of this.#closeHandlers.splice(0)) handler();
  }

  async #pumpStdout(handler: DataHandler): Promise<void> {
    const reader = this.#proc.stdout.getReader();
    const next = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) return;
      // Once closed, replies still coming are read and dropped, so the draining child never blocks on a full stdout.
      if (!this.#closed) await handler(value);
      return next();
    };
    return next();
  }

  async #pumpLog(): Promise<void> {
    let rest = "";
    for await (const text of this.#proc.stderr.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + text).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line !== "") this.#log(`hc connect[${this.pid}]: ${line}`);
    }
    if (rest !== "") this.#log(`hc connect[${this.pid}]: ${rest}`);
  }
}

/** Why `hc` could not be run at all: not there (a path, or a bare name not on PATH), not runnable, or anything else. */
export function hcSpawnError(hc: string, error: unknown): StartupError {
  const errno = errnoOf(error);
  const reason = error instanceof Error ? error.message : String(error);
  if (errno === "ENOENT" || errno === "ENOTDIR") {
    const where = /[\\/]/.test(hc) ? `at ${hc}` : `on PATH (${hc})`;
    return new StartupError("hc-binary-missing", `herdr-core was not found ${where}`, { path: hc }, { cause: error });
  }
  if (errno === "EACCES" || errno === "EPERM") {
    return new StartupError("permission-denied", `may not run ${hc} (${reason})`, { path: hc }, { cause: error });
  }
  // Anything else (EMFILE, ETXTBSY, ...) says nothing about which program hc is, so it is no hc-version-failed.
  return new StartupError("startup-failed", `cannot run ${hc}: ${reason}`, { path: hc }, { cause: error });
}

/**
 * `hc --version` checks still running. A process that exits while one runs (a start its caller gave up on) stops it on
 * the way out, so no version check outlives the process that asked for it (#2066).
 */
const versionChecks = new Set<Subprocess>();
process.on("exit", () => {
  for (const proc of versionChecks) proc.kill();
});

/** Runs `hc --version` and returns the bare version, e.g. "0.1.17". */
export async function readHcVersion(hc: string): Promise<string> {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([hc, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw hcSpawnError(hc, error);
  }
  versionChecks.add(proc);
  let out: string;
  let err: string;
  let code: number;
  try {
    [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    versionChecks.delete(proc);
  }
  const version = /^hc (\S+)/.exec(out.trim())?.[1];
  if (code !== 0 || version === undefined) {
    throw new StartupError("hc-version-failed", `\`${hc} --version\` failed (exit ${code}): ${(out + err).trim()}`, {
      path: hc,
    });
  }
  return version;
}
