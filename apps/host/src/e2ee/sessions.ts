import { base64urlEncode, CloseCode, type SecureLink, SessionKind } from "@doriface/crypto";
import { type PlanPolicy, requireWithin } from "@doriface/policy";
import type { Link } from "../link.ts";
import type { PushLink } from "../push/push-stream.ts";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { McpGrantStore } from "../state/mcp-grants.ts";
import type { MeshStore } from "../state/mesh.ts";
import { REVOKED } from "./accept.ts";

/** Live E2EE sessions by remote key, so a device, mesh or MCP revocation closes them with 4401. */
export class LiveSessions {
  readonly #devices: DeviceStore;
  readonly #mesh: MeshStore | undefined;
  readonly #grants: McpGrantStore | undefined;
  readonly #now: () => number;
  readonly #byKey = new Map<string, Set<SecureLink>>();
  readonly #log: (line: string) => void;
  #grantFailure: string | undefined;

  constructor(
    devices: DeviceStore,
    log: (line: string) => void,
    mesh?: MeshStore,
    grants?: McpGrantStore,
    now: () => number = Date.now,
  ) {
    this.#devices = devices;
    this.#mesh = mesh;
    this.#log = log;
    this.#grants = grants;
    this.#now = now;
  }

  /** Whether an authenticated session from the remote static key `key` (base64url) is open now. */
  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /** How many sessions this host serves now, for a plan's concurrent-session limit. */
  count(): number {
    let total = 0;
    for (const sessions of this.#byKey.values()) total += sessions.size;
    return total;
  }

  /** How many MCP sessions this host serves, optionally restricted to one grant key. */
  countMcp(key?: string): number {
    const groups = key === undefined ? this.#byKey.values() : [this.#byKey.get(key) ?? []];
    let total = 0;
    for (const sessions of groups) {
      for (const session of sessions) if (session.stream === "mcp") total++;
    }
    return total;
  }

  /** Re-checks session room and revocation before hc admission. */
  admitHc(session: SecureLink, policy: PlanPolicy): boolean {
    return this.admitLimited(session, policy);
  }

  /** A second plan check after the handshake: another session may have opened in the meantime. */
  admitLimited(session: SecureLink, policy: PlanPolicy): boolean {
    if (session.kind === SessionKind.Session) {
      const room = requireWithin(policy, "sessions", this.count());
      if (!room.allowed) {
        this.#log(`plan: refused a session at admission: ${room.message}`);
        session.close(CloseCode.RateLimited, room.message);
        return false;
      }
    }
    return this.add(session);
  }

  /**
   * Registers a session, then re-checks the stores: a revoke that ran during its handshake still closes it. False when
   * that re-check closed it.
   */
  add(session: SecureLink): boolean {
    const key = base64urlEncode(session.remoteStatic);
    const sessions = this.#byKey.get(key) ?? new Set();
    sessions.add(session);
    this.#byKey.set(key, sessions);
    session.onClose(() => {
      sessions.delete(session);
      if (sessions.size === 0 && this.#byKey.get(key) === sessions) this.#byKey.delete(key);
    });
    return !this.#closeRevoked().has(session);
  }

  /** Closes sessions no longer authorized on their stream, including MCP sessions if the grant file is unreadable. */
  closeRevoked(): void {
    this.#closeRevoked();
  }

  /**
   * Wraps a session's hc link so its authorization is checked again for every chunk, both ways, right before the chunk
   * is served or answered (#2530): a revoke written by another process takes effect on the next chunk, not the next
   * handshake. A refused chunk is dropped and the session closed with 4401; a store that cannot be read refuses.
   */
  guardHc(session: SecureLink, link: Link): Link {
    const allowed = this.#check(session);
    return {
      send: async (bytes) => {
        if (allowed()) await link.send(bytes);
      },
      onData: (handler) => link.onData((bytes) => (allowed() ? handler(bytes) : undefined)),
      onClose: (handler) => link.onClose(handler),
      close: () => link.close(),
    };
  }

  /**
   * The same check for a device's push stream, the other stream a device is served on: a revoked device neither sends
   * another subscription line nor gets another reply or notice on it.
   */
  guardPush(session: SecureLink): PushLink {
    return this.#guardStream(session);
  }

  /** A grant that stops being live cannot send or receive any more MCP bytes. */
  guardMcp(session: SecureLink): PushLink {
    return this.#guardStream(session);
  }

  #guardStream(session: SecureLink): PushLink {
    const allowed = this.#check(session);
    return {
      send: (bytes) => (allowed() ? session.send(bytes) : undefined),
      onData: (handler) => session.onData((bytes) => (allowed() ? handler(bytes) : undefined)),
      onClose: (handler) => session.onClose(handler),
      close: (code, reason) => session.close(code, reason),
    };
  }

  /**
   * Whether `session` may still be served now, for a resume, which carries an existing session onto a new link. A
   * refusal closes it with 4401, as a refused chunk does.
   */
  allows(session: SecureLink): boolean {
    return this.#check(session)();
  }

  /** The per-chunk check for one session: its key is encoded once; a refusal closes every revoked session. */
  #check(session: SecureLink): () => boolean {
    const key = base64urlEncode(session.remoteStatic);
    return () => {
      if (this.#authorizedNow(session, key)) return true;
      this.#closeRevoked();
      return false;
    };
  }

  /**
   * Still registered, and its key still authorized by both stores as they are on disk now. Each store costs one
   * synchronous stat per check (a re-read only after a write): the check must see a revoke the moment it is written, so
   * it is not batched over time; the watch is only the prompt close for idle sessions.
   */
  #authorizedNow(session: SecureLink, key: string): boolean {
    if (this.#byKey.get(key)?.has(session) !== true) return false;
    if (!this.#grantAllows(session, key)) return false;
    if (session.stream === "mcp") return true;
    try {
      return authorizes(key, this.#devices.pairedKeys(), this.#mesh?.authorizeIndex());
    } catch {
      return false;
    }
  }

  #grantAllows(session: SecureLink, key: string): boolean {
    const mcp = session.stream === "mcp";
    try {
      const allowed = mcp ? this.#grants?.live(key, this.#now()) !== undefined : this.#grants?.holds(key) !== true;
      this.#grantFailure = undefined;
      return allowed;
    } catch (error) {
      const failure = String(error);
      if (this.#grantFailure !== failure) this.#log(`cannot read the MCP grants: ${failure}`);
      this.#grantFailure = failure;
      return !mcp;
    }
  }

  #closeRevoked(): ReadonlySet<SecureLink> {
    const closed = new Set<SecureLink>();
    let paired: ReadonlySet<string>;
    let index: AuthorizeIndex | undefined;
    let unreadable = false;
    try {
      paired = this.#devices.pairedKeys();
      index = this.#mesh?.authorizeIndex();
    } catch (error) {
      this.#log(`cannot read the devices or mesh file, closing owner sessions: ${String(error)}`);
      paired = new Set();
      index = undefined;
      unreadable = true;
    }
    for (const [key, sessions] of this.#byKey) {
      const owner = authorizes(key, paired, index);
      for (const session of sessions) {
        if ((session.stream === "mcp" || owner) && this.#grantAllows(session, key)) continue;
        closed.add(session);
        const reason = unreadable
          ? "authorization stores could not be read"
          : (index?.deviceRefusal(key) ?? "key is no longer authorized");
        this.#log(`e2ee: close code=4401 source=live-sessions stream=${session.stream ?? "hc"}: ${reason}`);
        session.close(REVOKED.code, REVOKED.reason);
      }
    }
    return closed;
  }
}

/**
 * A machine or client member's key, or a paired device's that the mesh does not refuse. A client is a member of the
 * roster without a machine line, so it is kept by its own lookup: `member()` answers for a key that dials, and a revoked
 * client is in neither (design of #942).
 */
function authorizes(key: string, paired: ReadonlySet<string>, index: AuthorizeIndex | undefined): boolean {
  const member = index?.member(key) !== undefined || index?.client(key) !== undefined;
  return member || (paired.has(key) && index?.deviceRefusal(key) === undefined);
}
