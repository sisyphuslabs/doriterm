import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The ports the OS hands out by itself: to a listen on port 0 and as the local end of an outgoing connection. */
export interface PortRange {
  readonly first: number;
  readonly last: number;
}

/** IANA's dynamic range, which macOS and Windows use by default: the answer when the OS cannot be asked. */
export const IANA_DYNAMIC: PortRange = { first: 49152, last: 65535 };

const port = (text: string | undefined): number | undefined => {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
};

/** Two port numbers, first and last, separated by whitespace: Linux's ip_local_port_range, or two sysctl lines. */
export function parsePortRange(text: string): PortRange | undefined {
  const [first, last, ...rest] = text.trim().split(/\s+/);
  const range = { first: port(first), last: port(last) };
  if (rest.length > 0 || range.first === undefined || range.last === undefined || range.first > range.last) {
    return undefined;
  }
  return { first: range.first, last: range.last };
}

const linuxRange = (): string => {
  try {
    return readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  } catch {
    return "";
  }
};

const sysctlRange = (): string =>
  spawnSync("sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"], { encoding: "utf8" })
    .stdout ?? "";

/** The lowest port a run takes: below it sit the well-known and registered services a developer machine tends to run. */
export const BAND_FLOOR = 10_000;

/**
 * Where a run looks for `need` consecutive ports: below the ephemeral range, else above it. Neither a listen on port 0
 * nor an outgoing connection is ever given a port there, so a port picked and released stays free until its server
 * listens, unless a server asks for that very port.
 */
export function bandOutside(range: PortRange, need: number): PortRange {
  if (range.first - BAND_FLOOR >= need * 4) return { first: BAND_FLOOR, last: range.first - 1 };
  if (65535 - range.last >= need * 4) return { first: range.last + 1, last: 65535 };
  throw new Error(
    `the ephemeral range ${range.first}-${range.last} leaves no room for ${need} consecutive ports outside it`,
  );
}

/** This machine's ephemeral range, as its OS reports it, else IANA's. */
export function ephemeralRange(): PortRange {
  const reported = process.platform === "linux" ? linuxRange() : process.platform === "darwin" ? sysctlRange() : "";
  return parsePortRange(reported) ?? IANA_DYNAMIC;
}
