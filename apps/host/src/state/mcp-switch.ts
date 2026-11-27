import { join } from "node:path";
import { ensureStateDir, fileStamp, isRecord, readJson, writePrivateJson } from "./files.ts";
import type { DeviceStore } from "./devices.ts";
import { withStateLock } from "./lock.ts";
import type { MeshStore } from "./mesh.ts";

export const MCP_SWITCH_FILE = "mcp.json";

/** A host that never wrote the switch serves no MCP: the owner turns it on, and pairing is still the gate on top. */
const ENABLED_WITHOUT_SWITCH = false;

/** Whether anyone could open MCP on this host under the on-by-default releases: a paired device or a mesh client member. */
export const hasMcpPrincipals = (devices: DeviceStore, mesh: MeshStore): boolean =>
  devices.list().length > 0 || (mesh.authorizeIndex()?.clients().length ?? 0) > 0;

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
   * Run once at host start: a missing switch is written as on where someone could already use MCP (a host from the
   * on-by-default releases keeps serving its paired devices and mesh clients) and as off otherwise, so every host holds
   * an explicit setting and pairing later never turns MCP on. A switch already written is never changed. When who
   * could use it cannot be read, nothing is written: MCP stays off and the next start settles it.
   */
  settleUnset(hasPrincipals: () => boolean, log: (line: string) => void): void {
    if (fileStamp(this.#path) !== undefined) return;
    let enabled: boolean;
    try {
      enabled = hasPrincipals();
    } catch (error) {
      log(`mcp: cannot read who uses this host (${String(error)}); MCP stays off until the next start settles it`);
      return;
    }
    withStateLock(this.#dir, () => {
      if (fileStamp(this.#path) === undefined) writePrivateJson(this.#path, { version: 1, enabled });
    });
    this.#cached = undefined;
  }

  setEnabled(on: boolean): void {
    withStateLock(this.#dir, () => writePrivateJson(this.#path, { version: 1, enabled: on }));
    this.#cached = undefined;
  }
}
