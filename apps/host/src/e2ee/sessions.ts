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

  /** Registers a session, then re-checks the stores: a revoke that ran during its handshake still closes it. */
  add(session: SecureLink): void {
    const key = base64urlEncode(session.remoteStatic);
    const sessions = this.#byKey.get(key) ?? new Set();
    sessions.add(session);
    this.#byKey.set(key, sessions);
    session.onClose(() => {
      sessions.delete(session);
      if (sessions.size === 0 && this.#byKey.get(key) === sessions) this.#byKey.delete(key);
    });
    this.closeRevoked();
  }

  /**
   * Closes every session whose key is neither a current mesh member's nor a paired device's, and every one whose key
   * the mesh refuses as a device (a revoked or over-cap member, a member's device key). When a store cannot be read,
   * no session can be shown to be authorized, so every one is closed.
   */
  closeRevoked(): void {
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
      const member = index?.member(key) !== undefined;
      if (member || (paired.has(key) && index?.deviceRefusal(key) === undefined)) continue;
      for (const session of sessions) session.close(REVOKED.code, REVOKED.reason);
    }
  }
}
