import { base64urlEncode, resumeRequestId, type SecureSession } from "@doriface/crypto";
import type { E2eeWire } from "./links.ts";

/**
 * How long a detached session keeps its `hc connect` and its place after its link dropped, for the client to come back
 * (contract v1.11). Past it the session ends as a dropped one did before, and the client attaches anew. Long enough for
 * a phone that slept through the relay's own 90 s silence reaper and woke a minute later; short enough that a client
 * that is gone for good does not hold a session slot for long.
 */
export const RESUME_GRACE_MS = 120_000;
const IDLE_CLOSE = 4408;

/**
 * The hc sessions a client may come back to. A registered session is allowed to detach when its link drops; the clock
 * then runs, and stops when the client's resume binds a new link. A request that names no registered session, fails its
 * keys or carries a position the session cannot join is refused, and the caller closes its wire.
 */
export class ResumableSessions {
  readonly #sessions = new Map<string, SecureSession>();
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
    };
    session.allowResume();
    session.onDetached((reason) => {
      stop();
      this.#log(`session detached (${reason.message}); kept ${Math.round(this.#graceMs / 1000)} s for a resume`);
      timer = setTimeout(() => {
        if (session.detached) session.close(IDLE_CLOSE, "the resume window passed");
      }, this.#graceMs);
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

  /** The host is stopping: a session waiting for its client has no client to wait for, so it ends now. */
  closeDetached(code: number, reason: string): void {
    // Closing removes the session from the map; the list is taken first so the walk is not over a changing map.
    const kept = Array.from(this.#sessions.values());
    for (const session of kept) if (session.detached) session.close(code, reason);
  }

  /** Answers a resume request (the first message on `wire`) from the session it names; false when it cannot. */
  accept(wire: E2eeWire, request: Uint8Array, pending: readonly Uint8Array[]): boolean {
    const id = resumeRequestId(request);
    if (id === undefined) return false;
    const session = this.#sessions.get(base64urlEncode(id));
    if (session === undefined) {
      this.#log("resume refused: no such session");
      return false;
    }
    const accepted = session.accept(wire, request, pending);
    if (!accepted) this.#log("resume refused: the request does not fit the session");
    return accepted;
  }
}
