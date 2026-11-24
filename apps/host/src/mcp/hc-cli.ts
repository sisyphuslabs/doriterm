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
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const stop = (): void => child.kill();
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
