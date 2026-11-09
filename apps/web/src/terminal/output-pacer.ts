import { afterTimeout, ReplayMode, type ReplayEndReason, type ReplayTimer } from "./replay-mode.ts";
import { SynchronizedUpdate } from "./synchronized-update.ts";

/** At most this much output is written to a terminal per paint: a flood costs each frame a bounded slice (#560). */
export const FRAME_BYTES = 16 * 1024;
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

/** What an attach's replay needs: the connection's measured round trip, and what to do when the mode ends. */
export interface PacerReplay {
  readonly srtt: number | undefined;
  /** After the view's paint is released, for the end-hold that runs once. `synchronized` brings its own hold. */
  readonly onEnd?: (reason: ReplayEndReason) => void;
}

const nextFrame: FrameTimer = (run) => {
  const id = requestAnimationFrame(run);
  return () => cancelAnimationFrame(id);
};

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
 * An attach's first paint gets the same treatment for a bounded time ({@link beginReplay}, #812, design D5): written
 * unpaced while the view holds its paint, so a mount or a reattach shows the replay in one step instead of walking its
 * history past the person.
 */
export class OutputPacer {
  readonly #write: (bytes: Uint8Array) => void;
  readonly #frame: FrameTimer;
  #queue: Pending[] = [];
  #visible = true;
  #cancel: (() => void) | null = null;
  readonly #clock: Clock;
  readonly #timer: ReplayTimer;
  #update = new SynchronizedUpdate();
  /** When the update open in the written output opened, by {@link Clock}; null when none is open. */
  #openedAt: number | null = null;
  #replay: ReplayMode | null = null;
  readonly #replayListeners = new Set<() => void>();

  constructor(
    write: (bytes: Uint8Array) => void,
    frame: FrameTimer = nextFrame,
    clock: Clock = () => performance.now(),
    timer: ReplayTimer = afterTimeout,
  ) {
    this.#write = write;
    this.#frame = frame;
    this.#clock = clock;
    this.#timer = timer;
  }

  push(bytes: Uint8Array, credit: (bytes: number) => void = () => undefined): void {
    if (bytes.byteLength === 0) return;
    this.#queue.push({ bytes, credit });
    if (this.#visible && this.#freeWrites()) {
      this.#cancel?.();
      this.#cancel = null;
      this.#flush(true);
    }
    this.#replay?.frame(bytes.byteLength);
    this.#schedule();
  }

  /**
   * Enters replay mode for an attach's first paint (#812, design D5): its bytes are written as they arrive and the view
   * holds its paint until the mode ends. Output that opens its own synchronized update stands this down, so the two
   * holds never conflict; that is the path herdr-core's bracketed first paint takes.
   */
  beginReplay(replay: PacerReplay): void {
    const started = this.#replay === null;
    this.#replay?.cancel();
    const mode = new ReplayMode({
      clock: this.#clock,
      timer: this.#timer,
      srtt: replay.srtt,
      onEnd: (reason) => this.#endReplay(mode, replay.onEnd, reason),
    });
    this.#replay = mode;
    if (started) this.#notifyReplayChange();
  }

  /** Whether an attach's replay is being written: the view holds its paint while it is. */
  get replaying(): boolean {
    return this.#replay !== null;
  }

  /** Runs `listener` when replay mode starts or ends; returns how to stop. */
  onReplayChange(listener: () => void): () => void {
    this.#replayListeners.add(listener);
    return () => {
      this.#replayListeners.delete(listener);
    };
  }

  /** Whether output is still waiting to be written: queued bytes, or a frame already booked. */
  get busy(): boolean {
    return this.#queue.length > 0 || this.#cancel !== null;
  }

  /** Out of view: nothing is written. Back in view: what waited is written from the next frame. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#cancel?.();
    this.#cancel = null;
    this.#schedule();
  }

  /** Forgets queued output (the stream it came from is gone); its credit is not returned. */
  drop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#queue = [];
    this.#update = new SynchronizedUpdate();
    this.#openedAt = null;
    if (this.#replay !== null) {
      this.#replay.cancel();
      this.#replay = null;
      this.#notifyReplayChange();
    }
  }

  /** Inside a synchronized update, not yet open past its time: written as it arrives. */
  #unpaced(): boolean {
    return this.#openedAt !== null && this.#clock() - this.#openedAt < SYNCHRONIZED_UNPACED_MS;
  }

  /** Written as it arrives: inside a synchronized update, or a replay whose first paint is unpaced (#812). */
  #freeWrites(): boolean {
    return this.#unpaced() || this.#replay !== null;
  }

  #endReplay(mode: ReplayMode, onEnd: ((reason: ReplayEndReason) => void) | undefined, reason: ReplayEndReason): void {
    if (this.#replay !== mode) return;
    this.#replay = null;
    this.#notifyReplayChange();
    onEnd?.(reason);
    this.#schedule();
  }

  #notifyReplayChange(): void {
    for (const listener of this.#replayListeners) listener();
  }

  #schedule(): void {
    if (this.#cancel !== null || this.#queue.length === 0 || !this.#visible) return;
    const run = (): void => {
      this.#cancel = null;
      this.#flush();
      this.#schedule();
    };
    this.#cancel = this.#frame(run);
  }

  /** Writes a frame's batch; `arrived`: written as output arrives, it stops where the update ends, for the frame to go on. */
  #flush(arrived = false): void {
    const parts: Uint8Array[] = [];
    const credits: [(bytes: number) => void, number][] = [];
    let size = 0;
    while (this.#queue.length > 0) {
      const free = this.#freeWrites();
      if (!free && (arrived || size >= FRAME_BYTES)) break;
      const head = this.#queue[0];
      if (head === undefined) break;
      const room = free ? head.bytes.byteLength : Math.min(head.bytes.byteLength, FRAME_BYTES - size);
      // Read up to where an open update ends: what follows it is paced again.
      const take = this.#update.advance(head.bytes.subarray(0, room));
      if (!this.#update.open) this.#openedAt = null;
      else if (this.#openedAt === null) this.#openedAt = this.#clock();
      // The update holds its own paint (wterm's), so the replay stands down instead of holding a second time.
      if (this.#update.open) this.#replay?.standDown();
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
