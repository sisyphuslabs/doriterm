import { base64urlEncode, resumeRequestId, type SecureSession } from "@doriface/crypto";
import type { E2eeWire } from "./links.ts";

/**
 * How long a detached session keeps its `hc connect` and its place after its link dropped, for the client to come back
 * (contract v1.11). Past it the session ends as a dropped one did before, and the client attaches anew, its terminals
 * redrawn and what scrolled past meanwhile missing. A phone's socket drops the moment it goes to the background, and a
 * person is in another app for minutes, not seconds: at 120 s most returns found the session gone (#2853). Ten minutes
 * covers the usual app switch; a client gone for good holds its `hc connect` and a 1 MiB ring no longer than that.
 */
export const RESUME_GRACE_MS = 600_000;
/**
 * How many sessions wait for their client at once. This caps sessions, not processes: each waiting one keeps its
 * `hc connect` (5.4-7.8 MB resident each, measured on macOS arm64 with hc 0.1.22; an estimate elsewhere) and a ring of at
 * most 1 MiB, about 140 MB at 16. One more drop past the cap ends the session that has waited longest, whose client is
 * the least likely to come back; its `hc connect` gets its stdin closed and is killed if it has not exited within
 * DRAIN_GRACE_MS (2 s), so a child ended here can outlive its session by up to that long.
 */
export const MAX_DETACHED_SESSIONS = 16;
const IDLE_CLOSE = 4408;

/**
 * The hc sessions a client may come back to. A registered session is allowed to detach when its link drops; the clock
 * then runs, and stops when the client's resume binds a new link. A request that names no registered session, fails its
 * keys or carries a position the session cannot join is refused, and the caller closes its wire.
 */
export class ResumableSessions {
  readonly #sessions = new Map<string, SecureSession>();
  /** The sessions waiting for their client, the longest-waiting first. */
  readonly #waiting = new Set<SecureSession>();
  readonly #graceMs: number;
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void, graceMs = RESUME_GRACE_MS) {
    this.#log = log;
    this.#graceMs = graceMs;
  }

  /** How many sessions wait for their client now. */
  get detached(): number {
    let count = 0;
    for (const session of this.#sessions.values()) if (session.detached) count += 1;
    return count;
  }

  register(session: SecureSession): void {
    const id = base64urlEncode(session.resumeKeys.id);
    this.#sessions.set(id, session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
      this.#waiting.delete(session);
    };
    session.allowResume();
    session.onDetached((reason) => {
      stop();
      this.#log(`session detached (${reason.message}); kept ${Math.round(this.#graceMs / 1000)} s for a resume`);
      timer = setTimeout(() => {
        if (session.detached) session.close(IDLE_CLOSE, "the resume window passed");
      }, this.#graceMs);
      this.#waiting.add(session);
      this.#evictPastCap();
    });
    session.onLink(() => {
      stop();
      this.#log("session resumed on a new link");
    });
    session.onClose(() => {
      stop();
      if (this.#sessions.get(id) === session) this.#sessions.delete(id);
    });
  }

  /** Past {@link MAX_DETACHED_SESSIONS}, ends the sessions that have waited longest; closing one removes it from the set. */
  #evictPastCap(): void {
    for (const oldest of this.#waiting) {
      if (this.#waiting.size <= MAX_DETACHED_SESSIONS) return;
      this.#log(`session ended: ${MAX_DETACHED_SESSIONS} sessions already wait for their clients`);
      oldest.close(IDLE_CLOSE, "too many sessions wait for their clients");
      this.#waiting.delete(oldest);
    }
  }

  /** The host is stopping: a session waiting for its client has no client to wait for, so it ends now. */
  closeDetached(code: number, reason: string): void {
    // Closing removes the session from the map; the list is taken first so the walk is not over a changing map.
    const kept = Array.from(this.#sessions.values());
    for (const session of kept) if (session.detached) session.close(code, reason);
  }

  /**
   * Answers a resume request (the first message on `wire`) from the session it names; false when it cannot, or when
   * `allows` says the session's key is no longer authorized (a revoke written while it was detached, #2530).
   */
  accept(
    wire: E2eeWire,
    request: Uint8Array,
    pending: readonly Uint8Array[],
    allows: (session: SecureSession) => boolean,
  ): boolean {
    const id = resumeRequestId(request);
    if (id === undefined) return false;
    const session = this.#sessions.get(base64urlEncode(id));
    if (session === undefined) {
      this.#log("resume refused: no such session");
      return false;
    }
    if (!allows(session)) {
      this.#log("resume refused: the session's key is no longer authorized");
      return false;
    }
    const accepted = session.accept(wire, request, pending);
    if (!accepted) this.#log("resume refused: the request does not fit the session");
    return accepted;
  }
}
