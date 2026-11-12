import type { ByteLink } from "@doriface/client";
import { CloseCode, type SecureSession, SecureLinkError } from "@doriface/crypto";

/** A session the store can carry on over a new socket (contract v1.11): the session, and how to dial that socket. */
export interface ResumableSession {
  readonly secure: SecureSession;
  /** A fresh socket to the same host on the same path: the relay session's dial, or the direct address's. */
  readonly redial: (signal: AbortSignal) => Promise<ByteLink>;
}

/**
 * How long a detached session is dialed for before the store gives it up and opens a new one. Under the host's own
 * 120 s window after it noticed the drop, which may itself come up to 90 s after the socket died (the relay's silence
 * reaper), so a resume that can succeed does within this; past it the session is most likely gone on the host too.
 */
export const RESUME_BUDGET_MS = 60_000;
/** The waits between resume dials: short, since each dial is itself bounded, and cut short by a wake. */
export const RESUME_BACKOFF_MS = [500, 1_000, 2_000, 5_000] as const;

export interface ResumeHooks {
  /** The session is being carried on (true) or is carried on or given up (false). */
  readonly resuming: (on: boolean) => void;
  /** A dial or resume failed and another follows: why, so the page can say the host is not back yet. */
  readonly failed?: ((error: Error) => void) | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Why a connection dropped after its session could not be carried on: the store reconnects as before, and the
 * workspace says that its terminals were redrawn, since the old screen is replaced rather than continued.
 */
export class ResumeAbandonedError extends SecureLinkError {
  constructor(last: unknown) {
    super(CloseCode.IdleTimeout, `could not resume the session: ${message(last)}`, { cause: last });
  }
}

/**
 * A refusal a later dial cannot change: the host no longer knows this device, or it does not hold this session or
 * cannot join its position (4413), so the store opens a new session at once instead of dialing out the budget.
 */
const isFinal = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === CloseCode.UnknownDevice ||
    error.code === CloseCode.ResumeRefused ||
    // A host from before resume (contract v1.11) refuses the request as an unknown session kind, and a reply that is no
    // resume answer fails the same way: another dial meets the same host, so the store opens a new session at once.
    error.code === CloseCode.CryptoFailure);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why a dial in flight was abandoned: the page woke and a fresh dial replaces it at once. */
const WOKE = new Error("the page woke");

/**
 * Carries a detached session on: dials the host again and resumes the session over the new socket, again after a
 * backoff while that fails, until it succeeds or the budget runs out. Giving up abandons the session with the last
 * failure, which drops the connection the way a dropped link did before, so the store reconnects as it always has.
 */
export class SessionResumer {
  readonly #session: ResumableSession;
  readonly #hooks: ResumeHooks;
  readonly #budgetMs: number;
  #abort: AbortController | null = null;
  #wake: (() => void) | null = null;
  #running = false;
  #stopped = false;

  constructor(session: ResumableSession, hooks: ResumeHooks, budgetMs = RESUME_BUDGET_MS) {
    this.#session = session;
    this.#hooks = hooks;
    this.#budgetMs = budgetMs;
  }

  get active(): boolean {
    return this.#running;
  }

  /** The session detached for `reason`: dials until it is carried on or the budget is spent. */
  start(reason: Error): void {
    if (this.#running || this.#stopped || this.#session.secure.closed) return;
    this.#running = true;
    this.#hooks.log?.(`session detached (${reason.message}); resuming`);
    this.#hooks.resuming(true);
    void this.#run(reason);
  }

  /** The page can work again: a wait between dials ends now, and a dial in flight is replaced by a fresh one. */
  now(): void {
    if (!this.#running) return;
    this.#wake?.();
    this.#abort?.abort(WOKE);
  }

  /** The store is closing the connection: nothing more is dialed. */
  stop(): void {
    this.#stopped = true;
    this.#abort?.abort(new Error("stopped"));
    this.#wake?.();
    this.#end();
  }

  async #run(reason: Error): Promise<void> {
    const now = this.#hooks.now ?? Date.now;
    const startedAt = now();
    let last: unknown = reason;
    for (let attempt = 0; !this.#stopped; attempt += 1) {
      const secure = this.#session.secure;
      if (secure.closed) return this.#end();
      if (!secure.detached) return this.#carriedOn();
      const abort = new AbortController();
      this.#abort = abort;
      try {
        // oxlint-disable-next-line no-await-in-loop -- dials run one after another, each after its backoff
        const link = await this.#session.redial(abort.signal);
        if (abort.signal.aborted) {
          link.close();
          throw abort.signal.reason;
        }
        // oxlint-disable-next-line no-await-in-loop -- the resume on this dial's socket, before the next dial
        await secure.resume(link);
        return this.#carriedOn();
      } catch (error) {
        if (this.#stopped) return;
        // A dial the wake replaced is no failure: the next one goes at once.
        if (error === WOKE) continue;
        last = error;
        if (isFinal(error) || now() - startedAt >= this.#budgetMs) break;
        this.#hooks.log?.(`resume attempt ${attempt + 1} failed: ${message(error)}`);
        this.#hooks.failed?.(error instanceof Error ? error : new Error(String(error)));
        // oxlint-disable-next-line no-await-in-loop -- dials run one after another, each after its backoff
        await this.#wait(RESUME_BACKOFF_MS[Math.min(attempt, RESUME_BACKOFF_MS.length - 1)] ?? 5_000);
      } finally {
        if (this.#abort === abort) this.#abort = null;
      }
    }
    if (this.#stopped) return;
    this.#hooks.log?.(`giving the session up: ${message(last)}`);
    this.#end();
    this.#session.secure.abandon(new ResumeAbandonedError(last));
  }

  #carriedOn(): void {
    this.#hooks.log?.("session resumed");
    this.#end();
  }

  #end(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#hooks.resuming(false);
  }

  #wait(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      resolve();
    }
    this.#wake = done;
    return promise.finally(() => {
      if (this.#wake === done) this.#wake = null;
    });
  }
}
