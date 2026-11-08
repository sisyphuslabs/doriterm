import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A core's hc binary and environment, as the e2e host saved them for the specs, the host's pid when it saved one,
 * whether the host has finished setting up (its seeds started and its machine added, with that machine's seeds listed),
 * and the run that started it.
 */
export interface SavedEnv {
  readonly hc: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly ready?: boolean;
  /** The run id of the run that started this host (E2E_RUN_ID): another run's host is not this run's to stop (#1412). */
  readonly run?: string;
}

/**
 * Saves `saved` to `file` whole: it is written beside `file` and then renamed over it, which replaces the file in one
 * step, so a reader polling `file` sees the old contents or the new ones, never a truncated or half-written file.
 */
export function writeSavedEnv(file: string, saved: SavedEnv): void {
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(saved));
  renameSync(partial, file);
}

export function readSavedEnv(file: string): SavedEnv {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || !("hc" in value) || !("env" in value)) {
    throw new Error(`${file} holds no saved environment`);
  }
  const { hc, env } = value;
  if (typeof hc !== "string" || typeof env !== "object" || env === null) throw new Error(`${file} is malformed`);
  const pid: unknown = Reflect.get(value, "pid");
  const run: unknown = Reflect.get(value, "run");
  const saved = {
    hc,
    env: Object.fromEntries(Object.entries(env).map(([key, entry]) => [key, String(entry)])),
    ...(Reflect.get(value, "ready") === true ? { ready: true } : {}),
    ...(typeof run === "string" ? { run } : {}),
  };
  return typeof pid === "number" ? { ...saved, pid } : saved;
}

/**
 * The saved environment while a host may still be writing or removing `file`: undefined when it is not there or does
 * not parse, which a caller waiting for the host reads as "not ready yet" and asks again.
 */
export function readSavedEnvIfWhole(file: string): SavedEnv | undefined {
  try {
    return readSavedEnv(file);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (missing || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
