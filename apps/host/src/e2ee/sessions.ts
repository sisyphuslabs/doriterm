import { base64urlEncode, type SecureLink } from "@doriface/crypto";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { REVOKED } from "./accept.ts";

/** Live E2EE sessions by remote key, so a device or mesh revocation closes them with 4401. */
export class LiveSessions {
  readonly #devices: DeviceStore;
  readonly #mesh: MeshStore | undefined;
  readonly #byKey = new Map<string, Set<SecureLink>>();
  readonly #log: (line: string) => void;

  constructor(devices: DeviceStore, log: (line: string) => void, mesh?: MeshStore) {
    this.#devices = devices;
    this.#mesh = mesh;
    this.#log = log;
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

  /**
   * Closes every session whose key is neither a current machine member's, a current client member's, nor a paired
   * device's, and every one whose key the mesh refuses as a device (a revoked or over-cap member, a machine's device
   * key). When a store cannot be read, no session can be shown to be authorized, so every one is closed.
   */
  closeRevoked(): void {
    this.#closeRevoked();
  }

  #closeRevoked(): ReadonlySet<SecureLink> {
    const closed = new Set<SecureLink>();
    let paired: ReadonlySet<string>;
    let index: AuthorizeIndex | undefined;
    try {
      paired = new Set(this.#devices.list().map((device) => device.clientStaticPub));
      index = this.#mesh?.authorizeIndex();
    } catch (error) {
      this.#log(`cannot read the devices or mesh file, closing every session: ${String(error)}`);
      paired = new Set();
      index = undefined;
    }
    for (const [key, sessions] of this.#byKey) {
      // A client is a member of the roster without a machine line, so it is kept by its own lookup: `member()` answers
      // for a key that dials, and a revoked client is in neither (design of #942).
      const member = index?.member(key) !== undefined || index?.client(key) !== undefined;
      if (member || (paired.has(key) && index?.deviceRefusal(key) === undefined)) continue;
      for (const session of sessions) {
        closed.add(session);
        session.close(REVOKED.code, REVOKED.reason);
      }
    }
    return closed;
  }
}
