import { base64urlDecode, base64urlEncode, fingerprintOf } from "@doriface/crypto";
import { join } from "node:path";
import { ensureStateDir, fileStamp, isRecord, readJson, writePrivateJson } from "./files.ts";
import { withStateLock } from "./lock.ts";

export const MCP_GRANTS_FILE = "mcp-grants.json";

type Mode = "allow" | "ask";
interface Scopes {
  readonly "terminals:read"?: Mode;
  readonly "terminals:send"?: Mode;
  readonly "terminals:run"?: Mode;
  readonly "terminals:end"?: Mode;
  readonly "files:read"?: Mode;
  readonly "files:write"?: Mode;
  readonly exec?: "ask";
}

type Terminals =
  | { readonly kind: "started" }
  | { readonly kind: "spaces"; readonly spaces: readonly string[] }
  | { readonly kind: "all" };

export interface McpGrant {
  readonly key: string;
  readonly name: string;
  readonly kind: "device" | "session";
  readonly scopes: Scopes;
  readonly terminals: Terminals;
  readonly folders: readonly string[];
  readonly templates: readonly string[];
  readonly confirm: "owner" | "self";
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly approvedBy: string;
}

interface GrantState {
  readonly enabled: boolean;
  readonly grants: ReadonlyMap<string, McpGrant>;
  readonly burned: ReadonlySet<string>;
}

const EMPTY: GrantState = { enabled: false, grants: new Map(), burned: new Set() };
const malformed = (reason: string): Error => new Error(`${MCP_GRANTS_FILE}: ${reason}`);
const fingerprint = (grant: McpGrant): string => fingerprintOf(base64urlDecode(grant.key)).replaceAll(" ", "");
export const grantIdOf = (grant: McpGrant): string => fingerprint(grant).slice(0, 8);

const validKey = (key: unknown): key is string =>
  typeof key === "string" && /^[\w-]{43}$/.test(key) && base64urlEncode(base64urlDecode(key)) === key;
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const only = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function isScopes(value: unknown): value is Scopes {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, mode]) => {
    switch (key) {
      case "exec":
        return mode === "ask";
      case "terminals:read":
      case "terminals:send":
      case "terminals:run":
      case "terminals:end":
      case "files:read":
      case "files:write":
        return mode === "ask" || mode === "allow";
      default:
        return false;
    }
  });
}

function isTerminals(value: unknown): value is Terminals {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "started":
    case "all":
      return only(value, ["kind"]);
    case "spaces":
      return only(value, ["kind", "spaces"]) && strings(value["spaces"]);
    default:
      return false;
  }
}

const GRANT_FIELDS = [
  "key",
  "name",
  "kind",
  "scopes",
  "terminals",
  "folders",
  "templates",
  "confirm",
  "createdAt",
  "expiresAt",
  "approvedBy",
];

function freezeGrant(grant: McpGrant): McpGrant {
  Object.freeze(grant.scopes);
  if (grant.terminals.kind === "spaces") Object.freeze(grant.terminals.spaces);
  Object.freeze(grant.terminals);
  Object.freeze(grant.folders);
  Object.freeze(grant.templates);
  return Object.freeze(grant);
}

function isGrant(value: unknown): value is McpGrant {
  if (!isRecord(value) || !only(value, GRANT_FIELDS)) return false;
  const { key, name, kind, scopes, terminals, folders, templates, confirm, createdAt, expiresAt, approvedBy } = value;
  return (
    validKey(key) &&
    typeof name === "string" &&
    (kind === "device" || kind === "session") &&
    isScopes(scopes) &&
    isTerminals(terminals) &&
    strings(folders) &&
    strings(templates) &&
    (confirm === "owner" || confirm === "self") &&
    typeof createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt) &&
    Number.isFinite(Date.parse(createdAt)) &&
    Number.isSafeInteger(expiresAt) &&
    typeof approvedBy === "string"
  );
}

function parse(value: unknown): GrantState {
  if (value === undefined) return EMPTY;
  if (
    !isRecord(value) ||
    !only(value, ["version", "enabled", "grants", "burned"]) ||
    value["version"] !== 1 ||
    typeof value["enabled"] !== "boolean" ||
    !Array.isArray(value["grants"]) ||
    !Array.isArray(value["burned"])
  ) {
    throw malformed("unsupported format");
  }
  const grants = new Map<string, McpGrant>();
  const burned = new Set<string>();
  for (const grant of value["grants"]) {
    if (!isGrant(grant)) throw malformed("invalid grant");
    if (grants.has(grant.key)) throw malformed("duplicate grant key");
    grants.set(grant.key, freezeGrant(grant));
  }
  for (const key of value["burned"]) {
    if (!validKey(key)) throw malformed("invalid burned key");
    if (grants.has(key) || burned.has(key)) throw malformed("duplicate key in burned grants");
    burned.add(key);
  }
  return { enabled: value["enabled"], grants, burned };
}

/** The private MCP grant file. Atomic replacements invalidate other processes' cached reads on their next check. */
export class McpGrantStore {
  readonly #dir: string;
  readonly #path: string;
  #cached: { readonly stamp: string | undefined; readonly state: GrantState | Error } | undefined;

  constructor(stateDir: string) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, MCP_GRANTS_FILE);
  }

  enabled(): boolean {
    return this.#read().enabled;
  }

  setEnabled(on: boolean): void {
    withStateLock(this.#dir, () => this.#save({ ...this.#read(), enabled: on }));
  }

  list(): readonly McpGrant[] {
    return [...this.#read().grants.values()];
  }

  live(key: string, now: number): McpGrant | undefined {
    const { enabled, grants } = this.#read();
    const grant = enabled ? grants.get(key) : undefined;
    return grant !== undefined && now < grant.expiresAt ? grant : undefined;
  }

  holds(key: string): boolean {
    const { grants, burned } = this.#read();
    return grants.has(key) || burned.has(key);
  }

  add(grant: McpGrant): void {
    withStateLock(this.#dir, () => {
      const state = this.#read();
      if (!isGrant(grant)) throw malformed("invalid grant");
      if (state.burned.has(grant.key)) throw malformed("cannot add a burned key");
      this.#save({ ...state, grants: new Map(state.grants).set(grant.key, grant) });
    });
  }

  revoke(handle: string): readonly McpGrant[] {
    const id = handle.replaceAll(" ", "").toUpperCase();
    return this.#revoke((grant) => {
      const full = fingerprint(grant);
      return grant.key === handle || full === id || full.slice(0, 8) === id;
    }, handle);
  }

  revokeAll(): readonly McpGrant[] {
    return this.#revoke(() => true);
  }

  #revoke(matches: (grant: McpGrant) => boolean, handle?: string): readonly McpGrant[] {
    return withStateLock(this.#dir, () => {
      const state = this.#read();
      const removed = [...state.grants.values()].filter(matches);
      if (handle !== undefined && removed.length > 1) {
        throw new Error(`${handle} matches ${removed.length} grants; revoke one by its full fingerprint`);
      }
      if (removed.length > 0) {
        const grants = new Map(state.grants);
        const burned = new Set(state.burned);
        for (const { key } of removed) {
          grants.delete(key);
          burned.add(key);
        }
        this.#save({ enabled: state.enabled, grants, burned });
      }
      return removed;
    });
  }

  #read(): GrantState {
    let stamp: string | undefined;
    try {
      stamp = fileStamp(this.#path);
    } catch (error) {
      throw new Error(`${MCP_GRANTS_FILE}: cannot stat grants`, { cause: error });
    }
    if (this.#cached === undefined || this.#cached.stamp !== stamp) {
      let state: GrantState | Error;
      try {
        state = parse(readJson(this.#path));
      } catch (error) {
        state = new Error(`${MCP_GRANTS_FILE}: cannot read grants: ${String(error)}`, { cause: error });
      }
      this.#cached = { stamp, state };
    }
    const { state } = this.#cached;
    if (state instanceof Error) throw state;
    return state;
  }

  #save({ enabled, grants, burned }: GrantState): void {
    writePrivateJson(this.#path, { version: 1, enabled, grants: [...grants.values()], burned: [...burned] });
    this.#cached = undefined;
  }
}
