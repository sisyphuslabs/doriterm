import { SynchronizedUpdate } from "./synchronized-update.ts";

/** At most this much output is written to a terminal per paint: a flood costs each frame a bounded slice (#560). */
export const FRAME_BYTES = 16 * 1024;
/** A queue deeper than this at the start of a frame is a backlog: it is caught up in that frame (D5). */
export const CATCHUP_THRESHOLD = 2 * FRAME_BYTES;
/** The most a catch-up frame writes, as one batch: one credit window of the stream (D5). */
export const CATCHUP_FRAME_BYTES = 256 * 1024;
/** How often output is written while the app is hidden, when no animation frame runs (D5). */
export const HIDDEN_DRAIN_MS = 50;
/** An attach replay's paint is held at most this long from when it began (D5). */
export const REPLAY_CAP_MS = 1500;
/** An attach replay's paint is held for at most this much written output (D5). */
export const REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** The shortest quiet after the last replay bytes that ends a replay (D5). */
export const REPLAY_QUIET_FLOOR_MS = 100;
/**
 * How long a synchronized update is written unpaced, as wterm holds its paint for one (@wterm/dom's
 * `SYNCHRONIZED_OUTPUT_TIMEOUT_MS`, which output-pacer.test.ts reads from the installed package): past it the terminal
 * draws anyway, so the output is paced again.
 */
export const SYNCHRONIZED_UNPACED_MS = 1000;

/** Milliseconds from some fixed point, for how long an update has been open. */
export type Clock = () => number;

interface Pending {
  readonly bytes: Uint8Array;
  /** Hands the stream's credit back once these bytes are written (`TerminalStream.consumed`). */
  readonly credit: (bytes: number) => void;
}

/** Runs a callback on the next animation frame; returns how to cancel it. */
export type FrameTimer = (run: () => void) => () => void;

/** Runs a callback once `ms` from now; returns how to cancel it. */
export type Timer = (run: () => void, ms: number) => () => void;

const nextFrame: FrameTimer = (run) => {
  const id = requestAnimationFrame(run);
  return () => cancelAnimationFrame(id);
};

const after: Timer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/** What an attach replay needs from its view: the link's round trip, and how to hold the terminal's paint. */
export interface ReplayOptions {
  /** The connection's smoothed round trip in ms, or undefined before it has one. */
  readonly srtt: () => number | undefined;
  /** Holds the terminal's paint (true) and lets it go (false); each is called once per replay. */
  readonly hold: (held: boolean) => void;
}

interface Replay {
  readonly options: ReplayOptions;
  written: number;
  quiet: () => void;
  readonly cap: () => void;
}

/** How much a batch may take: a frame's bytes, a catch-up frame's, or the whole queue. */
type Budget = "arrived" | number;

/**
 * Paces a terminal's output to its paints (#560). Output that arrives is queued and written once a frame, as one batch
 * of at most FRAME_BYTES, and its credit goes back only then: the stream's window then throttles the program to what the
 * page draws, so a flood never fills the main thread and clicks and keys keep their turn. Out of view (a hidden tab),
 * nothing is written: output waits, uncredited, and is written once the terminal shows. Bytes keep their order, and a
 * batch may end inside a character or a sequence: the VT parses a stream.
 *
 * A synchronized update (DECSET 2026) is the exception: the terminal draws nothing of it until it ends, so pacing it
 * would only spread one frame over many paints, and a program redrawing its whole transcript on a resize (pi-tui, Claude
 * Code) would outlast the terminal's hold and be drawn top to bottom (#757). Its bytes are written the moment they
 * arrive, uncapped, until it ends or has been open {@link SYNCHRONIZED_UNPACED_MS}.
 *
 * Coming back to the app is drawn in one paint, not replayed (D5): while the app is hidden no frame runs, so the queue
 * is written whole every {@link HIDDEN_DRAIN_MS} and credited, and what is left when it shows is written at once; a
 * backlog deeper than {@link CATCHUP_THRESHOLD} at a frame is written in that frame, up to {@link CATCHUP_FRAME_BYTES};
 * and an attach replay is written as it arrives while the view holds its paint, until the replay goes quiet.
 */
export class OutputPacer {
  readonly #write: (bytes: Uint8Array) => void;
  readonly #frame: FrameTimer;
  readonly #timer: Timer;
  #queue: Pending[] = [];
  #visible = true;
  #hidden = false;
  /** Cancels the booked frame, or the hidden drain while the app is hidden; null when neither is booked. */
  #cancel: (() => void) | null = null;
  readonly #clock: Clock;
  #update = new SynchronizedUpdate();
  /** When the update open in the written output opened, by {@link Clock}; null when none is open. */
  #openedAt: number | null = null;
  #replay: Replay | null = null;

  constructor(
    write: (bytes: Uint8Array) => void,
    frame: FrameTimer = nextFrame,
    clock: Clock = () => performance.now(),
    timer: Timer = after,
  ) {
    this.#write = write;
    this.#frame = frame;
    this.#clock = clock;
    this.#timer = timer;
  }

  push(bytes: Uint8Array, credit: (bytes: number) => void = () => undefined): void {
    if (bytes.byteLength === 0) return;
    this.#queue.push({ bytes, credit });
    if (this.#replay !== null) this.#quietFrom(this.#replay);
    if (this.#visible && this.#unpaced()) {
      this.#cancel?.();
      this.#cancel = null;
      this.#flush("arrived");
    }
    this.#schedule();
  }

  /** Whether output is still waiting to be written: queued bytes, a frame or drain booked, or a replay held. */
  get busy(): boolean {
    return this.#queue.length > 0 || this.#cancel !== null || this.#replay !== null;
  }

  /** Out of view: nothing is written. Back in view: what waited is written from the next frame. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#cancel?.();
    this.#cancel = null;
    this.#schedule();
  }

  /**
   * The app went to the background (true) or came back (false). Hidden, no animation frame runs, so the queue is
   * written whole every {@link HIDDEN_DRAIN_MS}; shown again, what is left is written at once, for the paint the
   * terminal has already booked to draw it.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.#cancel?.();
    this.#cancel = null;
    if (!hidden && this.#visible) this.#flush(Infinity);
    this.#schedule();
  }

  /**
   * An attach replay begins: its output is written as it arrives, uncapped, while `hold` holds the terminal's paint, so
   * the replay is drawn once, whole, and the screen before it stays until then. The hold ends at the first of: no
   * output for max({@link REPLAY_QUIET_FLOOR_MS}, 1.5 x SRTT + 50) ms, {@link REPLAY_CAP_MS} since it began, or
   * {@link REPLAY_MAX_BYTES} written.
   */
  replay(options: ReplayOptions): void {
    if (this.#replay !== null) this.#endReplay();
    const replay: Replay = {
      options,
      written: 0,
      quiet: () => undefined,
      cap: this.#timer(() => this.#endReplay(), REPLAY_CAP_MS),
    };
    this.#replay = replay;
    options.hold(true);
    this.#quietFrom(replay);
    if (this.#visible && this.#queue.length > 0) {
      this.#cancel?.();
      this.#cancel = null;
      this.#flush("arrived");
    }
  }

  /** Forgets queued output (the stream it came from is gone); its credit is not returned. A replay held ends. */
  drop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#queue = [];
    this.#update = new SynchronizedUpdate();
    this.#openedAt = null;
    this.#endReplay();
  }

  #quietFrom(replay: Replay): void {
    replay.quiet();
    const quiet = Math.max(REPLAY_QUIET_FLOOR_MS, 1.5 * (replay.options.srtt() ?? 0) + 50);
    replay.quiet = this.#timer(() => this.#endReplay(), quiet);
  }

  #endReplay(): void {
    const replay = this.#replay;
    if (replay === null) return;
    this.#replay = null;
    replay.quiet();
    replay.cap();
    replay.options.hold(false);
    this.#schedule();
  }

  /** Inside a synchronized update not yet open past its time, or an attach replay: written as it arrives. */
  #unpaced(): boolean {
    if (this.#replay !== null) return true;
    return this.#openedAt !== null && this.#clock() - this.#openedAt < SYNCHRONIZED_UNPACED_MS;
  }

  #schedule(): void {
    if (this.#cancel !== null || this.#queue.length === 0 || !this.#visible) return;
    if (this.#hidden) {
      this.#cancel = this.#timer(() => {
        this.#cancel = null;
        this.#flush(Infinity);
        this.#schedule();
      }, HIDDEN_DRAIN_MS);
      return;
    }
    this.#cancel = this.#frame(() => {
      this.#cancel = null;
      this.#flush(this.#queued() > CATCHUP_THRESHOLD ? CATCHUP_FRAME_BYTES : FRAME_BYTES);
      this.#schedule();
    });
  }

  #queued(): number {
    let size = 0;
    for (const pending of this.#queue) size += pending.bytes.byteLength;
    return size;
  }

  /**
   * Writes one batch of at most `budget` bytes, or the whole queue. `"arrived"`: written as output arrives, it stops
   * where the update or replay ends, for the frame to go on.
   */
  #flush(budget: Budget): void {
    const parts: Uint8Array[] = [];
    const credits: [(bytes: number) => void, number][] = [];
    const limit = budget === "arrived" ? 0 : budget;
    let size = 0;
    while (this.#queue.length > 0) {
      const unpaced = this.#unpaced();
      if (!unpaced && size >= limit) break;
      const head = this.#queue[0];
      if (head === undefined) break;
      const room = unpaced ? head.bytes.byteLength : Math.min(head.bytes.byteLength, limit - size);
      // Read up to where an open update ends: what follows it is paced again.
      const take = this.#update.advance(head.bytes.subarray(0, room));
      if (!this.#update.open) this.#openedAt = null;
      else if (this.#openedAt === null) this.#openedAt = this.#clock();
      parts.push(take === head.bytes.byteLength ? head.bytes : head.bytes.subarray(0, take));
      credits.push([head.credit, take]);
      size += take;
      if (take === head.bytes.byteLength) this.#queue.shift();
      else this.#queue[0] = { bytes: head.bytes.subarray(take), credit: head.credit };
    }
    if (size === 0) return;
    const batch = parts.length === 1 ? (parts[0] ?? new Uint8Array()) : concat(parts, size);
    this.#write(batch);
    for (const [credit, bytes] of credits) credit(bytes);
    const replay = this.#replay;
    if (replay === null) return;
    replay.written += size;
    if (replay.written >= REPLAY_MAX_BYTES) this.#endReplay();
  }
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
