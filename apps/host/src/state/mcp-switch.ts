import { join } from "node:path";
import { ensureStateDir, fileStamp, isRecord, readJson, writePrivateJson } from "./files.ts";
import { withStateLock } from "./lock.ts";

export const MCP_SWITCH_FILE = "mcp.json";

/** A host that never wrote the switch serves MCP; pairing is still the gate, and an explicit off is kept. */
const ENABLED_WITHOUT_SWITCH = true;

function readEnabled(path: string): boolean {
  const value = readJson(path);
  if (value === undefined) return ENABLED_WITHOUT_SWITCH;
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["enabled"] !== "boolean" ||
    Object.keys(value).length !== 2
  ) {
    throw new Error("expected only version: 1 and a boolean enabled");
  }
  return value["enabled"];
}

/** The host's private MCP switch. A write by another process invalidates the cached read. */
export class McpSwitch {
  readonly #dir: string;
  readonly #path: string;
  #cached: { readonly stamp: string; readonly enabled: boolean | Error } | undefined;

  constructor(stateDir: string) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, MCP_SWITCH_FILE);
  }

  enabled(): boolean {
    let stamp: string | undefined;
    try {
      stamp = fileStamp(this.#path);
    } catch (cause) {
      throw new Error(`${this.#path}: ${String(cause)}`, { cause });
    }
    if (stamp === undefined) {
      this.#cached = undefined;
      return ENABLED_WITHOUT_SWITCH;
    }
    if (this.#cached?.stamp !== stamp) {
      try {
        this.#cached = { stamp, enabled: readEnabled(this.#path) };
      } catch (cause) {
        this.#cached = { stamp, enabled: new Error(`${this.#path}: ${String(cause)}`, { cause }) };
      }
    }
    if (this.#cached.enabled instanceof Error) throw this.#cached.enabled;
    return this.#cached.enabled;
  }

  setEnabled(on: boolean): void {
    withStateLock(this.#dir, () => writePrivateJson(this.#path, { version: 1, enabled: on }));
    this.#cached = undefined;
  }
}
