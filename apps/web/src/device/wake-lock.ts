/** The parts of the Screen Wake Lock API doriface uses, so tests can stand in for the browser. */
export interface WakeLockHandle {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface ScreenWakeLock {
  request(type: "screen"): Promise<WakeLockHandle>;
}

export interface Visibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Holds the screen wake lock while it is wanted and the page is visible. The browser drops the lock when the page is
 * hidden; this releases it too, so it is never held for a hidden page, and asks again when the page is shown. A
 * refused request (battery saver, no user activation) stays released until the next show or change of mind.
 */
export class ScreenAwake {
  readonly #lock: ScreenWakeLock;
  readonly #page: Visibility;
  #wanted = false;
  #held: WakeLockHandle | null = null;
  #asking = false;
  #refused = false;
  #settled: Promise<void> = Promise.resolve();

  constructor(lock: ScreenWakeLock, page: Visibility) {
    this.#lock = lock;
    this.#page = page;
    page.addEventListener("visibilitychange", () => {
      this.#refused = false;
      void this.#run();
    });
  }

  get held(): boolean {
    return this.#held !== null;
  }

  /** Resolves once the lock matches the latest wish and visibility. */
  settled(): Promise<void> {
    return this.#settled;
  }

  /** Whether the screen should stay awake while the page is visible; resolves once the lock matches. */
  want(wanted: boolean): Promise<void> {
    if (wanted !== this.#wanted) this.#refused = false;
    this.#wanted = wanted;
    return this.#run();
  }

  #run(): Promise<void> {
    const run = this.#sync();
    this.#settled = Promise.all([this.#settled, run]).then(() => undefined);
    return this.#settled;
  }

  async #sync(): Promise<void> {
    const keep = this.#wanted && this.#page.visibilityState === "visible";
    if (!keep && this.#held !== null) {
      const held = this.#held;
      this.#held = null;
      await held.release();
      return;
    }
    if (!keep || this.#held !== null || this.#asking || this.#refused) return;
    this.#asking = true;
    try {
      const held = await this.#lock.request("screen");
      this.#held = held;
      held.addEventListener("release", () => {
        if (this.#held === held) this.#held = null;
      });
    } catch (cause) {
      if (!(cause instanceof DOMException)) throw cause;
      this.#refused = true;
    } finally {
      this.#asking = false;
    }
    // The page may have been hidden, or the wish withdrawn, while the request was out.
    await this.#sync();
  }
}
