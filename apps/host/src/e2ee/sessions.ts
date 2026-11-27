import { base64urlEncode, CloseCode, type SecureLink, type SecureSession, SessionKind } from "@doriface/crypto";
import { type PlanPolicy, requireWithin } from "@doriface/policy";
import type { Link } from "../link.ts";
import type { PushLink } from "../push/push-stream.ts";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { McpSwitch } from "../state/mcp-switch.ts";
import type { MeshStore } from "../state/mesh.ts";
import { REVOKED } from "./accept.ts";

/** Live E2EE sessions by remote key, so a device or mesh revocation closes them with 4401. */
export class LiveSessions {
  readonly #devices: DeviceStore;
  readonly #mesh: MeshStore | undefined;
  readonly #mcp: McpSwitch | undefined;
  readonly #byKey = new Map<string, Set<SecureLink>>();
  /** When each resumable session last detached, in order, so the one that has waited longest is replaced first. */
  readonly #detachedAt = new WeakMap<SecureLink, number>();
  #detaches = 0;
  readonly #log: (line: string) => void;
  #mcpFailure: string | undefined;

  constructor(devices: DeviceStore, log: (line: string) => void, mesh?: MeshStore, mcp?: McpSwitch) {
    this.#devices = devices;
    this.#mesh = mesh;
    this.#log = log;
    this.#mcp = mcp;
  }

  /** Whether an authenticated session from the remote static key `key` (base64url) is open now. */
  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /**
   * How many sessions this host serves now, for a plan's concurrent-session limit. `replacing` names the key asking for
   * a new workspace session: its own sessions that wait for a resume (detached) are not counted, since its admission
   * may replace as many of them as it needs (#2853). A device that dropped in the background and comes back to a new
   * session is not refused for the one it left behind; any other key still counts every session, waiting or not.
   */
  count(replacing?: string): number {
    let total = 0;
    for (const [key, sessions] of this.#byKey)
      for (const session of sessions) if (key !== replacing || !isWaiting(session)) total += 1;
    return total;
  }

  mcpSessions(): readonly { readonly key: string }[] {
    const live: { readonly key: string }[] = [];
    for (const [key, sessions] of this.#byKey) {
      for (const session of sessions) if (session.stream === "mcp") live.push({ key });
    }
    return live;
  }

  /**
   * Re-checks session room and revocation before a workspace (hc) session is admitted. A device whose new workspace
   * session finds the plan full ends as many of its own waiting sessions as that needs, oldest first, and no more: its
   * other views stay resumable (#2853).
   */
  admitHc(session: SecureLink, policy: PlanPolicy): boolean {
    return this.#admit(session, policy, true);
  }

  /** A second plan check after the handshake: another session may have opened in the meantime. Replaces nothing. */
  admitLimited(session: SecureLink, policy: PlanPolicy): boolean {
    return this.#admit(session, policy, false);
  }

  #admit(session: SecureLink, policy: PlanPolicy, workspace: boolean): boolean {
    if (session.kind === SessionKind.Session) {
      const key = base64urlEncode(session.remoteStatic);
      const room = requireWithin(policy, "sessions", this.count(workspace ? key : undefined));
      if (!room.allowed) {
        this.#log(`plan: refused a session at admission: ${room.message}`);
        session.close(CloseCode.RateLimited, room.message);
        return false;
      }
      if (workspace) this.#makeRoom(key, policy);
    }
    return this.add(session);
  }

  /** Ends `key`'s waiting sessions, oldest first, only until the plan has room for one more. */
  #makeRoom(key: string, policy: PlanPolicy): void {
    let open = this.count();
    const byWait = (a: SecureLink, b: SecureLink): number =>
      (this.#detachedAt.get(a) ?? 0) - (this.#detachedAt.get(b) ?? 0);
    for (const waiting of [...(this.#byKey.get(key) ?? [])].filter(isWaiting).toSorted(byWait)) {
      if (requireWithin(policy, "sessions", open).allowed) return;
      this.#log("plan: a session waiting for its client was replaced by a new session from the same device");
      waiting.close(CloseCode.IdleTimeout, "replaced by a new session from the same device");
      open -= 1;
    }
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
    if (isResumable(session)) session.onDetached(() => this.#detachedAt.set(session, (this.#detaches += 1)));
    return !this.#closeRevoked().has(session);
  }

  /**
   * Closes every session whose key is no longer authorized by the devices and mesh stores. If one of those stores
   * cannot be read every session is closed. An off or unreadable MCP switch closes only MCP sessions.
   */
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
    const allowed = this.#check(session);
    return {
      send: (bytes) => (allowed() ? session.send(bytes) : undefined),
      onData: (handler) => session.onData((bytes) => (allowed() ? handler(bytes) : undefined)),
      onClose: (handler) => session.onClose(handler),
      close: (code, reason) => session.close(code, reason),
    };
  }

  guardMcp(session: SecureLink): PushLink {
    return this.guardPush(session);
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
    try {
      return (
        authorizes(key, this.#devices.pairedKeys(), this.#mesh?.authorizeIndex()) &&
        (session.stream !== "mcp" || this.#mcpEnabled())
      );
    } catch {
      return false;
    }
  }

  #mcpEnabled(): boolean {
    try {
      const enabled = this.#mcp?.enabled() === true;
      this.#mcpFailure = undefined;
      return enabled;
    } catch (error) {
      const failure = String(error);
      if (this.#mcpFailure !== failure) this.#log(`cannot read the MCP switch: ${failure}`);
      this.#mcpFailure = failure;
      return false;
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
      this.#log(`cannot read the devices or mesh file, closing every session: ${String(error)}`);
      paired = new Set();
      index = undefined;
      unreadable = true;
    }
    let mcpEnabled: boolean | undefined;
    for (const [key, sessions] of this.#byKey) {
      const authorized = authorizes(key, paired, index);
      for (const session of sessions) {
        if (authorized && (session.stream !== "mcp" || (mcpEnabled ??= this.#mcpEnabled()))) continue;
        closed.add(session);
        const reason = unreadable
          ? "authorization stores could not be read"
          : authorized
            ? "MCP is off on this host"
            : (index?.deviceRefusal(key) ?? "key is no longer authorized");
        this.#log(`e2ee: close code=4401 source=live-sessions stream=${session.stream ?? "hc"}: ${reason}`);
        session.close(REVOKED.code, REVOKED.reason);
      }
    }
    return closed;
  }
}

/** A session that can outlive its link (contract v1.11); the others never wait for a resume. */
const isResumable = (session: SecureLink): session is SecureSession => "onDetached" in session;

/** A session whose link dropped and that waits for its client's resume (contract v1.11). */
const isWaiting = (session: SecureLink): boolean => "detached" in session && session.detached === true;

/**
 * A machine or client member's key, or a paired device's that the mesh does not refuse. A client is a member of the
 * roster without a machine line, so it is kept by its own lookup: `member()` answers for a key that dials, and a revoked
 * client is in neither (design of #942).
 */
function authorizes(key: string, paired: ReadonlySet<string>, index: AuthorizeIndex | undefined): boolean {
  const member = index?.member(key) !== undefined || index?.client(key) !== undefined;
  return member || (paired.has(key) && index?.deviceRefusal(key) === undefined);
}
