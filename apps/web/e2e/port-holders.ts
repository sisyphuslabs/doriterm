import { spawnSync } from "node:child_process";
import { HOST_BLOCK, PORT_TRY_LIMIT } from "./port-block.ts";

export interface TriedBlock {
  readonly base: number;
  readonly blocked: number;
}

export interface PortHolder {
  readonly port: number;
  readonly pid: number;
  readonly command: string;
}

interface Parsed {
  readonly pid: number;
  readonly command: string;
}

const lsofFields = (output: string): readonly Parsed[] => {
  const holders: Parsed[] = [];
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const kind = line.slice(0, 1);
    const rest = line.slice(1);
    if (kind === "p") {
      const parsed = Number(rest);
      if (Number.isInteger(parsed) && parsed > 0) {
        pid = parsed;
        command = "";
      }
    } else if (kind === "c") {
      command = rest;
    } else if (kind === "n" && pid > 0) {
      holders.push({ pid, command });
      pid = 0;
    }
  }
  return holders;
};

const ssFields = (output: string): readonly Parsed[] => {
  const holders: Parsed[] = [];
  for (const match of output.matchAll(/users:\(\("([^"]+)",pid=(\d+)/g)) {
    const command = match[1] ?? "";
    const pid = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0) holders.push({ pid, command });
  }
  return holders;
};

interface PortTool {
  readonly name: string;
  readonly args: (port: number) => string[];
  readonly parse: (output: string) => readonly Parsed[];
  /** Whether this run's exit status means "no listener found" rather than "the tool itself failed". */
  readonly noMatch: (status: number | null, stdout: string, stderr: string) => boolean;
}

/** What names a port's listener, in the order tried: `ss` (iproute2) on Linux, `lsof` everywhere. */
const TOOLS: readonly PortTool[] = [
  ...(process.platform === "linux"
    ? [
        {
          name: "ss",
          args: (port: number) => ["-ltnpH", `sport = :${String(port)}`],
          parse: ssFields,
          // ss exits 0 whether or not it matched; any non-zero status is its own failure (e.g. no netlink permission).
          noMatch: (status: number | null) => status === 0,
        },
      ]
    : []),
  {
    name: "lsof",
    args: (port: number) => ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-F", "pcn"],
    parse: lsofFields,
    // lsof exits 1 with no output when nothing matches; anything else is its failure (another status, or a message).
    noMatch: (status: number | null, stdout: string, stderr: string) =>
      status === 0 || (status === 1 && stdout.trim() === "" && stderr.trim() === ""),
  },
];

export interface PortHolders {
  readonly holders: readonly PortHolder[];
  /**
   * Why no listener could be named at all (no tool could run and report): the ports' holders are then unknown, not
   * none.
   */
  readonly unnamed?: string;
}

/**
 * Names the listeners on `ports` with the first tool that runs and reports cleanly. A tool that cannot be started or
 * that fails is never read as "nothing holds the port": the next one is tried, and when none works the result says so
 * in `unnamed`.
 */
export function listPortHolders(
  ports: readonly number[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): PortHolders {
  const valid = ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);
  const failed: string[] = [];
  for (const tool of TOOLS) {
    const holders: PortHolder[] = [];
    let error: string | undefined;
    for (const port of valid) {
      const result = spawnSync(tool.name, tool.args(port), { encoding: "utf8", env });
      if (result.error !== undefined) {
        error = Reflect.get(result.error, "code") === "ENOENT" ? "not installed" : result.error.message;
        break;
      }
      if (!tool.noMatch(result.status, result.stdout, result.stderr)) {
        const message = result.stderr.trim().split("\n")[0]?.trim() ?? "";
        error =
          result.status === null
            ? "stopped before it reported"
            : `failed with exit ${String(result.status)}${message === "" ? "" : `: ${message}`}`;
        break;
      }
      for (const { pid, command } of tool.parse(result.stdout)) {
        holders.push({ port, pid, command: command === "" ? "(unknown)" : command });
      }
    }
    if (error === undefined) return { holders };
    failed.push(`${tool.name} ${error}`);
  }
  return { holders: [], unnamed: failed.join(", ") };
}

export function describePortFailure(tried: readonly TriedBlock[], { holders, unnamed }: PortHolders): string {
  const attempts =
    tried.length === 0
      ? "none recorded"
      : tried
          .map(({ base, blocked }) => (blocked > 0 ? `${String(base)} blocked at ${String(blocked)}` : String(base)))
          .join(", ");
  const named =
    unnamed !== undefined
      ? `the blocked ports' listeners could not be looked up (${unnamed})`
      : holders.length === 0
        ? "no listener could be named on the blocked ports"
        : holders
            .map(({ port, pid, command }) => `port ${String(port)} held by pid ${String(pid)} (${command})`)
            .join("; ");
  return `no ${String(HOST_BLOCK)}-port block in ${String(PORT_TRY_LIMIT)} tries; last bases tried: ${attempts}; ${named}`;
}
