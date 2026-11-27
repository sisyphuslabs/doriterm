import { join } from "node:path";
import { ensureStateDir, fileStamp, isRecord, readJson, writePrivateJson } from "./files.ts";
import { withStateLock } from "./lock.ts";

export const MCP_SWITCH_FILE = "mcp.json";

/** A host that never wrote the switch serves no MCP: the owner turns it on, and pairing is still the gate on top. */
const ENABLED_WITHOUT_SWITCH = false;

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

  /**
   * Run once at host start: a missing switch is written as on where devices are already paired (a host from the
   * on-by-default releases keeps serving the assistants it has) and as off otherwise, so every host holds an explicit
   * setting and pairing a device later never turns MCP on. A switch already written is never changed.
   */
  settleUnset(hasPairedDevices: boolean): void {
    withStateLock(this.#dir, () => {
      if (fileStamp(this.#path) === undefined) {
        writePrivateJson(this.#path, { version: 1, enabled: hasPairedDevices });
      }
    });
    this.#cached = undefined;
  }

  setEnabled(on: boolean): void {
    withStateLock(this.#dir, () => writePrivateJson(this.#path, { version: 1, enabled: on }));
    this.#cached = undefined;
  }
}
