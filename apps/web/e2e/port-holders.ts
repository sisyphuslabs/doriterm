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

const parse = (port: number, output: string): readonly PortHolder[] =>
  (process.platform === "linux" ? ssFields(output) : lsofFields(output)).map(({ pid, command }) => ({
    port,
    pid,
    command: command === "" ? "(unknown)" : command,
  }));

const probe = (port: number): string => {
  const [command, args] =
    process.platform === "linux"
      ? ["ss", ["-ltnpH", `sport = :${port}`]]
      : ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"]];
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : "";
};

export function listPortHolders(ports: readonly number[]): readonly PortHolder[] {
  const holders: PortHolder[] = [];
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    holders.push(...parse(port, probe(port)));
  }
  return holders;
}

export function describePortFailure(tried: readonly TriedBlock[], holders: readonly PortHolder[]): string {
  const attempts =
    tried.length === 0
      ? "none recorded"
      : tried
          .map(({ base, blocked }) => (blocked > 0 ? `${String(base)} blocked at ${String(blocked)}` : String(base)))
          .join(", ");
  const named =
    holders.length === 0
      ? "no listener could be named on the blocked ports"
      : holders
          .map(({ port, pid, command }) => `port ${String(port)} held by pid ${String(pid)} (${command})`)
          .join("; ");
  return `no ${String(HOST_BLOCK)}-port block in ${String(PORT_TRY_LIMIT)} tries; last bases tried: ${attempts}; ${named}`;
}
