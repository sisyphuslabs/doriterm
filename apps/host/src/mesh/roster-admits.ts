import { base64urlEncode } from "@doriface/crypto";
import { MAX_REVOKE_SUBJECTS } from "@doriface/mesh";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readJson, removeFile, stringField, writePrivateJson } from "../state/files.ts";
import type { RosterDeps } from "./roster.ts";
import { announceChange } from "./announce.ts";
import { checkFloor } from "./merge.ts";

export interface RosterAdmit {
  readonly admitId: string;
  readonly signPub: string;
  readonly devicePub: string;
}

/** Local provenance only. Every write happens inside the mesh transaction's state lock. */
export class RosterAdmits {
  readonly #path: string;

  constructor(stateDir: string) {
    this.#path = join(stateDir, "roster-admits.json");
  }

  read(): readonly RosterAdmit[] | undefined {
    const value = readJson(this.#path);
    if (value === undefined) return undefined;
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["admits"])) {
      throw new Error("roster-admits.json: unsupported format");
    }
    return value["admits"].map((entry: unknown) => {
      if (!isRecord(entry)) throw new Error("roster-admits.json: malformed entry");
      return {
        admitId: stringField(entry, "admitId", "roster-admits.json"),
        signPub: stringField(entry, "signPub", "roster-admits.json"),
        devicePub: stringField(entry, "devicePub", "roster-admits.json"),
      };
    });
  }

  writeHeld(entries: readonly RosterAdmit[] | undefined): void {
    if (entries === undefined) removeFile(this.#path);
    else writePrivateJson(this.#path, { version: 1, admits: entries });
  }
}

/** Missing or unreadable provenance never authorizes a destructive mesh-wide revoke. */
export function sweepRoster(deps: RosterDeps): void {
  if (deps.mesh.read() === undefined) return;
  try {
    const changed = deps.mesh.transact((tx) => {
      const marker = new RosterAdmits(deps.stateDir);
      const entries = marker.read();
      if (entries === undefined) {
        deps.log("mesh: roster sweep skipped: roster-admits.json is missing");
        return;
      }
      if (!existsSync(join(deps.stateDir, "devices.json"))) {
        deps.log("mesh: roster sweep skipped: devices.json is missing");
        return;
      }
      const paired = new Set(deps.devices.list().map((device) => device.clientStaticPub));
      const self = base64urlEncode(deps.identity.sign.publicKey);
      const clients = deps.mesh.authorizeIndex()?.clients() ?? [];
      const current = entries.filter((entry) =>
        clients.some(
          (client) =>
            client.signPub === entry.signPub &&
            client.admitId === entry.admitId &&
            client.devicePub === entry.devicePub &&
            client.admitter === self,
        ),
      );
      const removed = current.filter((entry) => !paired.has(entry.devicePub)).map((entry) => entry.signPub);
      if (current.length !== entries.length) marker.writeHeld(current);
      checkFloor(tx.records, self, deps.floor());
      const mesh = deps.mesh.read()?.meshId;
      if (mesh === undefined) return;
      for (let i = 0; i < removed.length; i += MAX_REVOKE_SUBJECTS) {
        const signPubs = removed.slice(i, i + MAX_REVOKE_SUBJECTS);
        tx.sign(deps.identity, (n, prev) => ({
          v: 2,
          mesh,
          type: "revoke",
          by: self,
          n,
          prev,
          subject: { signPubs, reason: "revoke" },
        }));
      }
      return removed.length > 0;
    });
    if (changed === true) announceChange(deps);
  } catch (error) {
    deps.log(`mesh: roster sweep stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
