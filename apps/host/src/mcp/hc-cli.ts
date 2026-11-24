import { MAX_MCP_LINE, toolResult } from "./lines.ts";
/** What one hc command printed and how it ended; stdout and stderr are cut to fit one MCP reply line. */
export interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface HcCliTarget {
  readonly hc: string;
  readonly session?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export type RunHcCli = (
  argv: readonly string[],
  options: { readonly stdin?: string | undefined; readonly timeoutMs: number; readonly signal: AbortSignal },
) => Promise<CliResult>;

const STDOUT_LIMIT = 160 * 1024;
const STDERR_LIMIT = 16 * 1024;
const KILL_GRACE_MS = 2000;

/** A reply carries the result twice (content text and structuredContent); escapes and non-ASCII grow it more. */
const lineBytes = (result: CliResult): number =>
  Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolResult(result, result.exitCode !== 0) }));
/** Room for the id and envelope a real reply adds beyond the probe above. */
const LINE_BUDGET = MAX_MCP_LINE - 4096;

/** Cuts stdout until the reply fits one MCP line, measured on the encoded reply rather than on characters. */
export function fitReply(result: CliResult): CliResult {
  if (lineBytes(result) <= LINE_BUDGET) return result;
  let low = 0;
  let high = result.stdout.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineBytes({ ...result, stdout: result.stdout.slice(0, mid), truncated: true }) <= LINE_BUDGET) low = mid;
    else high = mid - 1;
  }
  return { ...result, stdout: result.stdout.slice(0, low), truncated: true };
}

/**
 * The environment an MCP command runs with: the host's, on its own core session, and never as a terminal (an inherited
 * HC_TERMINAL_ID would make hc pick that terminal for a verb left without one, or deliver notes to it).
 */
export function cliEnv(target: HcCliTarget): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.env ?? process.env)) {
    if (value !== undefined && key !== "HC_TERMINAL_ID") env[key] = value;
  }
  if (target.session !== undefined) env["HC_SESSION"] = target.session;
  return env;
}

/** Runs `hc <argv>` as the hc CLI would, with a deadline and cancellation. */
export function hcCli(target: HcCliTarget): RunHcCli {
  return async (argv, { stdin, timeoutMs, signal }) => {
    const child = Bun.spawn([target.hc, ...argv], {
      env: cliEnv(target),
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let timedOut = false;
    // A program that ignores SIGTERM is killed outright a moment later, so a call never outlives its deadline.
    // The command runs in its own process group, so whatever it started ends with it and cannot hold the pipes open.
    const signalGroup = (kill: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid, kill);
      } catch {
        child.kill(kill);
      }
    };
    const end = (): void => {
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, timeoutMs);
    const stop = end;
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [out, err, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const truncated = out.length > STDOUT_LIMIT || err.length > STDERR_LIMIT;
      return { exitCode, stdout: out.slice(0, STDOUT_LIMIT), stderr: err.slice(0, STDERR_LIMIT), truncated, timedOut };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  };
}
