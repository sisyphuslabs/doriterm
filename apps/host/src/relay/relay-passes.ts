import { join } from "node:path";
import type { HostIdentity } from "@doriface/crypto";
import { fromBase64Url, PassBook, type PassStore, type StoredPass, toBase64Url } from "@doriface/relay-client";
import { isRecord, readJson, writePrivateJson } from "../state/files.ts";

export const RELAY_PASSES_FILE = "relay-passes.json";

function parseEntry(value: unknown): StoredPass | undefined {
  if (!isRecord(value)) return undefined;
  const { pass, offsetMs, receivedAt } = value;
  if (typeof pass !== "string" || typeof offsetMs !== "number" || typeof receivedAt !== "number") return undefined;
  const bytes = fromBase64Url(pass);
  return bytes === undefined ? undefined : { pass: bytes, offsetMs, receivedAt };
}

/**
 * `relay-passes.json` in the state dir: the newest pass per relay origin with its clock offset (contract v1.6). Written
 * by the running host and read by the `mesh join` CLI, so every write replaces the file atomically (0600).
 */
export function relayPassFile(stateDir: string): PassStore {
  const path = join(stateDir, RELAY_PASSES_FILE);
  return {
    load: () => {
      const file = readJson(path);
      const entries = isRecord(file) && isRecord(file["passes"]) ? Object.entries(file["passes"]) : [];
      return new Map(
        entries.flatMap(([origin, value]) => {
          const entry = parseEntry(value);
          return entry === undefined ? [] : [[origin, entry] as const];
        }),
      );
    },
    save: (passes) => {
      const out = Object.fromEntries(
        [...passes].map(([origin, entry]) => [origin, { ...entry, pass: toBase64Url(entry.pass) }]),
      );
      writePrivateJson(path, { version: 1, passes: out });
    },
  };
}

export function openRelayPasses(
  stateDir: string,
  identity: HostIdentity,
  log: (line: string) => void,
): Promise<PassBook> {
  return PassBook.create({ secretKey: identity.sign.secretKey, store: relayPassFile(stateDir), log });
}

/**
 * The passes for a process with no running host (a `mesh join` run by the CLI itself): read from the file, never
 * written back, so a refusal marks a pass unusable in memory only and the running host's store stays its own.
 */
export function openReadOnlyRelayPasses(
  stateDir: string,
  identity: HostIdentity,
  log: (line: string) => void,
): Promise<PassBook> {
  const file = relayPassFile(stateDir);
  return PassBook.create({
    secretKey: identity.sign.secretKey,
    store: { load: file.load, save: () => undefined },
    log,
  });
}
