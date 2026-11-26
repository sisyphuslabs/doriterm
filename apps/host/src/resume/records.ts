/**
 * What the host keeps for OSC 7577 per terminal it started: the terminal's token (so reports verify after the host
 * itself restarts while the core runs on), the run facts a relaunch repeats, and at most one record, last write wins.
 * Every change is written at once to an owner-only file, as a record is as sensitive as a shell startup file.
 */
import { join } from "node:path";
import { ensureStateDir, readJson, writePrivateJson } from "../state/files.ts";
import { hasControl } from "./osc7577.ts";

/** The most records one host keeps; a terminal that already holds one may still replace it. */
export const MAX_RECORDS = 256;
const VERSION = 1;
const FILE = "resume.json";
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

export interface ResumeRecord {
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  /** The cwd came from the report's own key: a directory gone by the resume then means no resume. */
  readonly cwdReported: boolean;
  readonly pid: number;
  /** The owner's start time as the OS reports it, so a reused pid reads as another process. */
  readonly started: string | undefined;
  /** The owner was the terminal's first process, so it comes back as the first process again. */
  readonly firstProcess: boolean;
  readonly time: number;
  readonly uid: number;
}

/** A terminal the host started with a token: what its run gave it, so a relaunch can give the same. */
export interface TrackedTerminal {
  readonly token: string;
  /** The name the run gave it (a relaunch asks for it again, so a layout pane finds it); null for an unnamed run. */
  readonly name: string | null;
  /** The terminal identity the client passed (TERM, TERM_PROGRAM, COLORTERM); nothing else of the run's env. */
  readonly env: Readonly<Record<string, string>>;
}

export interface TerminalEntry extends TrackedTerminal {
  readonly record: ResumeRecord | undefined;
  /** The time of the last accepted report, by pid. */
  readonly lastTimes: Readonly<Record<string, number>>;
}

export type Accepted = "accepted" | "unknown" | "full";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === "string");
const isNumberMap = (value: unknown): value is Record<string, number> =>
  isObject(value) && Object.values(value).every((item) => Number.isSafeInteger(item));
const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function recordOf(value: unknown): ResumeRecord | undefined {
  if (!isObject(value)) return undefined;
  const { argv, cwd, cwdReported, pid, started, firstProcess, time, uid } = value;
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] === "") return undefined;
  if (!argv.every((item): item is string => typeof item === "string" && !hasControl(item))) return undefined;
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/") || hasControl(cwd))) return undefined;
  if (typeof cwdReported !== "boolean" || typeof firstProcess !== "boolean") return undefined;
  if (!isPositive(pid) || !isPositive(time) || !Number.isSafeInteger(uid)) return undefined;
  if (started !== undefined && typeof started !== "string") return undefined;
  return { argv, cwd, cwdReported, pid, started, firstProcess, time, uid: Number(uid) };
}

/** A stored entry, read back whole or not at all: the file is the host's own, but it is still read from disk. */
function entryOf(value: unknown): TerminalEntry | undefined {
  if (!isObject(value)) return undefined;
  const { token, name, env, record, lastTimes } = value;
  if (typeof token !== "string" || !TOKEN.test(token)) return undefined;
  if (name !== null && typeof name !== "string") return undefined;
  if (!isStringMap(env) || !isNumberMap(lastTimes)) return undefined;
  const parsed = record === undefined ? undefined : recordOf(record);
  if (record !== undefined && parsed === undefined) return undefined;
  return { token, name, env, record: parsed, lastTimes };
}

export class ResumeStore {
  readonly dir: string;
  readonly #entries: Map<string, TerminalEntry>;
  readonly #maxRecords: number;

  private constructor(dir: string, entries: Map<string, TerminalEntry>, maxRecords: number) {
    this.dir = dir;
    this.#entries = entries;
    this.#maxRecords = maxRecords;
  }

  /** The store in `dir` (created owner-only when missing); a file of another version starts empty. */
  static open(dir: string, maxRecords = MAX_RECORDS): ResumeStore {
    ensureStateDir(dir);
    const stored = readJson(join(dir, FILE));
    const entries = new Map<string, TerminalEntry>();
    if (isObject(stored) && stored["version"] === VERSION && isObject(stored["terminals"])) {
      for (const [address, value] of Object.entries(stored["terminals"])) {
        const entry = entryOf(value);
        if (entry !== undefined) entries.set(address, entry);
      }
    }
    return new ResumeStore(dir, entries, maxRecords);
  }

  entry(address: string): TerminalEntry | undefined {
    return this.#entries.get(address);
  }

  addresses(): string[] {
    return [...this.#entries.keys()];
  }

  lastTime(address: string, pid: number): number | undefined {
    return this.#entries.get(address)?.lastTimes[String(pid)];
  }

  /** A terminal the host just started with a token. */
  track(address: string, terminal: TrackedTerminal): void {
    this.#set(address, { ...terminal, record: undefined, lastTimes: {} });
  }

  /** Keeps `record` as the terminal's one record; "unknown" for a terminal the host did not start. */
  accept(address: string, record: ResumeRecord): Accepted {
    const entry = this.#entries.get(address);
    if (entry === undefined) return "unknown";
    const held = [...this.#entries.values()].filter((each) => each.record !== undefined).length;
    if (entry.record === undefined && held >= this.#maxRecords) return "full";
    this.#set(address, { ...entry, record, lastTimes: { ...entry.lastTimes, [String(record.pid)]: record.time } });
    return "accepted";
  }

  /**
   * Removes the record when it is `pid`'s: on `clear=1` (an accepted report, so its `time` becomes the pid's last and an
   * earlier report replayed inside the window is ignored), or when the owner has exited (no time).
   */
  clear(address: string, pid: number, time?: number): void {
    const entry = this.#entries.get(address);
    if (entry !== undefined && time !== undefined) {
      this.#set(address, { ...entry, lastTimes: { ...entry.lastTimes, [String(pid)]: time } });
    }
    this.#dropOwned(address, pid);
  }

  /** A rejected report from `pid`: its owner's command changed, so the record it left goes. */
  reject(address: string, pid: number): void {
    this.#dropOwned(address, pid);
  }

  /** The terminal is over for good (it ended by itself, or was closed): its token and record go. */
  forget(address: string): void {
    if (this.#entries.delete(address)) this.#save();
  }

  /** Removes a terminal to relaunch it, writing that first: a relaunch that fails is never tried again. */
  take(address: string): TerminalEntry | undefined {
    const entry = this.#entries.get(address);
    this.forget(address);
    return entry;
  }

  #dropOwned(address: string, pid: number): void {
    const entry = this.#entries.get(address);
    if (entry?.record?.pid === pid) this.#set(address, { ...entry, record: undefined });
  }

  #set(address: string, entry: TerminalEntry): void {
    this.#entries.set(address, entry);
    this.#save();
  }

  #save(): void {
    writePrivateJson(join(this.dir, FILE), { version: VERSION, terminals: Object.fromEntries(this.#entries) });
  }
}
