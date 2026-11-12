import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { LocalHostEndpoint, LocalHostFailure } from "../shared/bridge.ts";
import type { HostCommand } from "./host-command.ts";
import { StderrTail } from "./host-failure.ts";

export interface LocalHostOptions {
  readonly command: HostCommand;
  /**
   * Finds the herdr-core binary at each start, so a Retry after installing it finds it; undefined leaves doriface-host
   * on its own default (`hc` on PATH).
   */
  readonly hc: () => string | undefined;
  /** The folders `hc` searches after PATH, named by an `hc-binary-missing` failure. */
  readonly searched?: () => readonly string[];
  /**
   * The folder doriface-host starts in, and so the folder of an `hc` core it starts: a new terminal with no directory
   * opens there. The app's own folder is wherever its launcher started it, such as a Windows shortcut's install folder
   * (#2047).
   */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly readyTimeoutMs?: number | undefined;
}

export class LocalHostStartError extends Error {
  override readonly name = "LocalHostStartError";
  readonly failure: LocalHostFailure;

  constructor(failure: LocalHostFailure) {
    super(failure.details);
    this.failure = failure;
  }
}

/** doriface-host logs this line once its loopback listener is up. */
const READY_LINE = /listening on (ws:\/\/\S+?\/v1\/hc)(?:\s|$)/;
const STDERR_TAIL = 20;

/**
 * One doriface-host child on an ephemeral loopback port with its relay uplink, started on demand and shared by every
 * caller.
 */
export class LocalHost {
  readonly #options: LocalHostOptions;
  #starting: Promise<LocalHostEndpoint> | undefined;
  #child: ChildProcess | undefined;

  constructor(options: LocalHostOptions) {
    this.#options = options;
  }

  start(): Promise<LocalHostEndpoint> {
    if (this.#starting !== undefined) return this.#starting;
    const starting: Promise<LocalHostEndpoint> = this.#spawn().catch((error: unknown) => {
      // A stop() followed by a new start() may already have replaced this attempt.
      if (this.#starting === starting) this.#starting = undefined;
      throw error;
    });
    this.#starting = starting;
    return starting;
  }

  /** Signals the child (doriface-host closes its pipes on SIGTERM) and resolves once it exits. */
  stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#starting = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    return exited;
  }

  #spawn(): Promise<LocalHostEndpoint> {
    const { command, hc, cwd, env, log } = this.#options;
    const token = randomBytes(32).toString("base64url");
    const binary = hc();
    const args = [
      ...command.args,
      "--listen",
      "127.0.0.1:0",
      "--relay",
      DEFAULT_RELAY_URL,
      ...(binary === undefined ? [] : ["--hc", binary]),
    ];
    const child = spawn(command.file, args, {
      cwd,
      env: { ...env, DORIFACE_HOST_TOKEN: token },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const tail = new StderrTail(STDERR_TAIL);
    return new Promise<LocalHostEndpoint>((resolve, reject) => {
      let ready = false;
      let exit: string | undefined;
      let stderrEnded = false;
      // The exit event can come before the last stderr lines are read; the reason is final once both have happened.
      const failOnExit = (): void => {
        if (exit !== undefined && stderrEnded) fail("host-exited", `exited before listening (${exit})`);
      };
      const fail = (code: string, reason: string): void => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        const output = tail.text();
        const details = `doriface-host ${reason}${output === "" ? "" : `:\n${output}`}`;
        const report = { code, message: `doriface-host ${reason}`, ...tail.report };
        const searched = report.code === "hc-binary-missing" ? this.#options.searched?.() : undefined;
        reject(new LocalHostStartError({ ...report, ...(searched === undefined ? {} : { searched }), details }));
      };
      const timer = setTimeout(
        () =>
          exit === undefined
            ? fail("host-timeout", "did not start in time")
            : fail("host-exited", `exited before listening (${exit})`),
        this.#options.readyTimeoutMs ?? 15_000,
      );
      const stderr = createInterface({ input: child.stderr });
      stderr.once("close", () => {
        stderrEnded = true;
        failOnExit();
      });
      stderr.on("line", (line) => {
        log(`doriface-host: ${line}`);
        tail.push(line);
        const url = READY_LINE.exec(line)?.[1];
        if (url === undefined || ready) return;
        ready = true;
        clearTimeout(timer);
        resolve({ url, token });
      });
      child.once("error", (error) => fail("host-spawn-failed", `could not start (${error.message})`));
      child.once("exit", (code, signal) => {
        exit = signal ?? `code ${String(code)}`;
        failOnExit();
        if (this.#child === child) {
          this.#child = undefined;
          this.#starting = undefined;
        }
        log(`doriface-host exited (${exit})`);
      });
    });
  }
}
