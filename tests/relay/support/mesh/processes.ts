interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export type ProcessKind = "host" | "cli" | "hc-connect" | "hc-core" | "relay";

export interface Owned {
  readonly kind: ProcessKind;
  readonly pid: number;
}

export async function processTable(): Promise<readonly Row[]> {
  const ps = Bun.spawn(["ps", "-Ao", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
  });
}

export function treeOf(rows: readonly Row[], pid: number): readonly number[] {
  const out = [pid];
  for (let index = 0; index < out.length; index += 1) {
    const parent = out[index];
    for (const row of rows) if (row.ppid === parent && !out.includes(row.pid)) out.push(row.pid);
  }
  return out;
}

/** Signals each pid; one that already exited is skipped, any other failure is thrown. */
export function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
