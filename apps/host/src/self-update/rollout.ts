import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This host's place in a staged rollout (#1969), as electron-updater's isStagingMatch does for the desktop app: a random
 * id written once to <state dir>/updater-id and kept, hashed to a number from 0 to 100, offered a version when that number
 * is below its rollout. The id never leaves the machine.
 */
export function updaterId(stateDir: string): string {
  const file = join(stateDir, "updater-id");
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(kept)) return kept;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const id = randomUUID();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** The id's place from 0 (inclusive) to 100 (exclusive): its SHA-256's first four bytes over 2^32. */
export function rolloutPlace(id: string): number {
  return (createHash("sha256").update(id).digest().readUInt32BE(0) / 2 ** 32) * 100;
}

export const inRollout = (id: string, rollout: number): boolean => rolloutPlace(id) < rollout;
