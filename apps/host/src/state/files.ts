import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateFile, openPrivateStateDir, readPrivateFile, replacePrivateFile } from "./win32/private-state.ts";

/** Windows keeps private state with ACLs, not mode bits (#406); every other platform keeps the POSIX rules. */
const WINDOWS = process.platform === "win32";

/** $DORIFACE_HOST_STATE_DIR, else $XDG_STATE_HOME/doriface-host, else ~/.local/state/doriface-host. */
export function defaultStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env["DORIFACE_HOST_STATE_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".local", "state"), "doriface-host");
}

/**
 * Identifies one written file, or undefined when there is none: every write renames a new file into place, so its inode
 * and times change. A reader whose stamp still matches can trust what it read last. It assumes no two writes land in
 * one file-time tick with the same reused inode and the same size (a revoke and a same-size re-pair within ~1-4 ms).
 */
export function fileStamp(path: string): string | undefined {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? undefined : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Creates the state dir owner-only (0700); an existing dir is tightened to 0700 too. */
export function ensureStateDir(dir: string): string {
  if (WINDOWS) return openPrivateStateDir(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/** The parsed JSON at `path`, or undefined when the file does not exist. */
export function readJson(path: string): unknown {
  if (WINDOWS) {
    const bytes = readPrivateFile(path);
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return JSON.parse(text);
}

const jsonBytes = (value: unknown): Uint8Array => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const temporaryFor = (path: string): string => `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;

/**
 * Writes a fresh temporary file and, when `durable`, flushes it to disk, so a rename after a crash never publishes an
 * empty file; a failed write removes what it created, but never another writer's file.
 */
function writeTemporary(path: string, value: unknown, durable: boolean): string {
  const temporary = temporaryFor(path);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, text);
    if (durable) fsyncSync(fd);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return temporary;
}

/** Flushes a directory entry change (a rename or a new link) to disk. */
function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `value` as JSON readable by the owner only (0600), replacing the file atomically. `durable: false` skips the
 * flushes to disk (the file's and its directory's): the replacement is still atomic, but a crash may lose it. Only for
 * state whose crash safety is not what a test checks (#91).
 */
export function writePrivateJson(path: string, value: unknown, durable = true): void {
  if (WINDOWS) return replacePrivateFile(path, jsonBytes(value));
  const temporary = writeTemporary(path, value, durable);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  if (durable) syncDirectory(path);
}

/**
 * Creates `path` with `value` only if it does not exist yet, publishing the fully written file with a hard link (which
 * never replaces), so a concurrent reader sees no file or the whole file. Returns false when another writer won.
 * `durable` as for {@link writePrivateJson}.
 */
export function createPrivateJson(path: string, value: unknown, durable = true): boolean {
  if (WINDOWS) return createPrivateFile(path, jsonBytes(value));
  const temporary = writeTemporary(path, value, durable);
  try {
    linkSync(temporary, path);
    if (durable) syncDirectory(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export const removeFile = (path: string): void => rmSync(path, { force: true });

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function stringField(record: Readonly<Record<string, unknown>>, key: string, file: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${file}: ${key} must be a string`);
  return value;
}
