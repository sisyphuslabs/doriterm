import { HeldUpdate } from "./held-update.ts";
import { onTime } from "./late-timer.ts";
import { CREDIT_WINDOW_BYTES, REPLAY_MAX_BYTES, ReplayHold, type ReplayOptions } from "./replay-hold.ts";
import { opensUpdate, SynchronizedUpdate } from "./synchronized-update.ts";

/** At most this much output is written to a terminal per paint: a flood costs each frame a bounded slice (#560). */
export const FRAME_BYTES = 16 * 1024;
/** Catching up, a queue deeper than this at the start of a frame is a backlog: it is caught up in that frame (D5). */
export const CATCHUP_THRESHOLD = 2 * FRAME_BYTES;
/** The most a catch-up frame writes, as one batch: one credit window of the stream (D5). */
export const CATCHUP_FRAME_BYTES = CREDIT_WINDOW_BYTES;
/** How often output is written while the app is hidden, when no animation frame runs (D5). */
export const HIDDEN_DRAIN_MS = 50;
export {
  CREDIT_WINDOW_BYTES,
  REPLAY_CAP_MS,
  REPLAY_MAX_BYTES,
  REPLAY_QUIET_FLOOR_MS,
  REPLAY_TRICKLE_BYTES,
  type ReplayOptions,
} from "./replay-hold.ts";
export { SYNCHRONIZED_HOLD_CAP_MS, SYNCHRONIZED_UNPACED_MS } from "./held-update.ts";

export { LATE_TIMER_MS } from "./late-timer.ts";
/** The least a shell's answer to a resize may be: a themed prompt redrawn twice, whatever the terminal's width (#2922). */
export const RESIZE_ANSWER_MIN_BYTES = 2 * 1024;

/** Milliseconds from some fixed point, for how long an update has been open. */
export type Clock = () => number;

interface Pending {
  readonly bytes: Uint8Array;
  /** Hands the stream's credit back once these bytes are written (`TerminalStream.consumed`). */
  readonly credit: (bytes: number) => void;
  /** Arrived within a round trip of the view's resize: the shell answering it (a prompt redrawn on SIGWINCH, #2922). */
  readonly answer: boolean;
}

/** Runs a callback on the next animation frame; returns how to cancel it. */
export type FrameTimer = (run: () => void) => () => void;

/** Runs a callback once `ms` from now; returns how to cancel it. */
export type Timer = (run: () => void, ms: number) => () => void;

export const nextFrame: FrameTimer = (run) => {
  const id = requestAnimationFrame(run);
  return () => cancelAnimationFrame(id);
};

export const after: Timer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/** Coming back to the app or attaching: how much its catch-up frames may write, and have written. */
interface CatchUp {
  readonly budget: number;
  written: number;
}

/** How much a batch may take: a frame's bytes, a catch-up frame's, or the whole queue. */
type Budget = "arrived" | number;

/**
 * Paces a terminal's output to its paints (#560). Output that arrives is queued and written once a frame, as one batch
 * of at most FRAME_BYTES, and its credit goes back only then: the stream's window then throttles the program to what the
 * page draws, so a flood never fills the main thread and clicks and keys keep their turn. Out of view (a hidden tab),
 * nothing is written: output waits, uncredited, so at most the stream's credit window of it, and is written all at once
 * when the terminal shows, before its first paint: a tab switched to shows its screen as it is now, never a fast-forward
 * of what it missed climbing up from older output (#1588). Bytes keep their order, and a batch may end inside a
 * character or a sequence: the VT parses a stream.
 *
 * A synchronized update (DECSET 2026) is the exception: the terminal draws nothing of it until it ends, so pacing it
 * would only spread one frame over many paints, and a program redrawing its whole transcript on a resize (pi-tui, Claude
 * Code) would outlast the terminal's hold and be drawn top to bottom (#757). Its bytes are written the moment they
 * arrive, uncapped, and the terminal's paint is held (`holdSynchronized`) while they keep coming, past wterm's own
 * one-second hold, which a page too slow to take a whole redraw in would otherwise outlast (#2040). The hold ends when
 * the update closes, so it is drawn whole; when no bytes of it have come for max({@link SYNCHRONIZED_UNPACED_MS},
 * 1.5 x SRTT + 50) ms, as an update a program left open (#853, #2306); or at {@link SYNCHRONIZED_HOLD_CAP_MS}. What
 * is left of an update past its hold is paced.
 *
 * Coming back to the app is drawn in one paint, not replayed (D5): while the app is hidden no frame runs, so the queue
 * is written whole every {@link HIDDEN_DRAIN_MS} and credited, and what is left when it shows is written at once.
 * Catching up, after the app comes back or an attach replay starts, a backlog deeper than
 * {@link CATCHUP_THRESHOLD} at a frame is written in that frame, up to {@link CATCHUP_FRAME_BYTES}, until the queue
 * is under it or one credit window (or the backlog at its start, if larger) is written; a flood otherwise stays paced
 * at {@link FRAME_BYTES}. An attach replay is written as it arrives while the view holds its paint, until the replay
 * goes quiet; a synchronized update met inside it stands the replay down, since the update holds the paint itself,
 * even one that opens and closes within the same chunk (#812).
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
  /** Holds the terminal's paint (true) and lets it go (false) for a synchronized update. */
  #holdSynchronized: (held: boolean) => void = () => undefined;
  /** The open update whose paint is held while its bytes still arrive. */
  readonly #held = new HeldUpdate({
    timer: (run, ms) => this.#timer(run, ms),
    onTime: (ms, then, again) => this.#onTime(ms, then, again),
    srtt: () => this.#srtt(),
    hold: (held) => this.#holdSynchronized(held),
    ended: () => this.#schedule(),
    paintMaxBytes: REPLAY_MAX_BYTES,
  });
  /** The link's smoothed round trip, from the last attach's replay options; an attach without one leaves it unknown. */
  #srtt: () => number | undefined = () => undefined;
  /** The attach replay whose paint is held while it arrives. */
  readonly #replay = new ReplayHold({
    onTime: (ms, then, again) => this.#onTime(ms, then, again),
    ended: (wrote) => {
      // Every write of the replay landed while the paint was held, so a listener placing the view (hold-view-from-end)
      // placed it on the layout before the replay; the release draws the replay, so the listeners are told once more.
      // A replay that went quiet before any of it arrived drew nothing: telling them then would end a hold that has not
      // placed the view on the replay yet, and leave it wherever the terminal's reset scrolled it (#1394).
      if (wrote) for (const listener of this.#written) listener();
      this.#schedule();
    },
  });
  /**
   * When output that is not a shell's answer to a resize last arrived, by {@link Clock}: a late timer's reading compares
   * it to tell whether bytes came behind it (late-timer.ts). An answer the hold ignores must not restart it there (#2941).
   */
  #lastBytes = 0;
  /** When the view last resized, by {@link Clock}, and how many more bytes the shell may answer that resize with. */
  #resizedAt = Number.NEGATIVE_INFINITY;
  #answerLeft = 0;
  #catchUp: CatchUp | null = null;
  readonly #written = new Set<() => void>();

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
    const now = this.#clock();
    const answer = now - this.#resizedAt <= this.#roundTrip() && bytes.byteLength <= this.#answerLeft;
    if (answer) this.#answerLeft -= bytes.byteLength;
    this.#queue.push({ bytes, credit, answer });
    if (!answer) this.#lastBytes = now;
    this.#replay.arrived();
    // A shell's answer to a resize is not the held update still being drawn: a drag must not keep its paint held.
    if (!answer) this.#held.drawing();
    if (this.#visible && this.#unpaced()) {
      this.#cancel?.();
      this.#cancel = null;
      this.#flush("arrived");
    }
    this.#schedule();
  }

  /**
   * How a synchronized update holds the terminal's paint. wterm holds one for a second and then draws it, partly
   * written, on a page too slow to take it in (#2040); this holds it while its bytes keep coming, each within
   * max({@link SYNCHRONIZED_UNPACED_MS}, 1.5 x SRTT + 50) ms of the last: over a link whose round trip nears a second,
   * a redraw spanning several credit windows waits a round trip for each, and is not let go between two of them
   * (#2306). The floor keeps an update left open on a fast link drawn a second after its last bytes (#853).
   */
  holdSynchronized(hold: (held: boolean) => void): void {
    this.#holdSynchronized = hold;
  }

  /** Whether output is still waiting to be written: queued bytes, a frame or drain booked, or a replay held. */
  get busy(): boolean {
    return this.#queue.length > 0 || this.#cancel !== null || this.#replay.active;
  }

  /** Runs `listener` after each batch is written to the terminal; returns how to stop. */
  onWrite(listener: () => void): () => void {
    this.#written.add(listener);
    return () => {
      this.#written.delete(listener);
    };
  }

  /** Out of view: nothing is written. Back in view: what waited is written now, in one batch; later output is paced. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#cancel?.();
    this.#cancel = null;
    if (visible && !this.#hidden) this.#flush(Infinity);
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
    if (!hidden) this.#startCatchUp();
    this.#schedule();
  }

  /** An attach replay begins: its output is written as it arrives while its paint is held ({@link ReplayHold}). */
  replay(options: ReplayOptions): void {
    this.#srtt = options.srtt;
    this.#replay.begin(options);
    this.#startCatchUp();
    if (this.#visible && this.#queue.length > 0) {
      this.#cancel?.();
      this.#cancel = null;
      this.#flush("arrived");
    }
  }

  /**
   * The view resized to `cols` columns. A shell answers a resize by redrawing its prompt line (bash and zsh on
   * SIGWINCH: a return, the line blanked, the prompt; about two rows' bytes, a themed prompt a few hundred at any
   * width): within a round trip, up to three rows of the new width or {@link RESIZE_ANSWER_MIN_BYTES}, whichever is
   * more, are that answer, not an update being drawn, so a drag does not keep an update left open held (#2922). A
   * program redrawing in answer to the resize sends screens, past that, and keeps its hold (#757, #2040); one sent in
   * pieces smaller than that falls back to its quiet window.
   */
  resized(cols: number): void {
    this.#resizedAt = this.#clock();
    this.#answerLeft = Math.max(3 * cols, RESIZE_ANSWER_MIN_BYTES);
  }

  /**
   * The stream that brought the output closed (the program ended, or the link went down): a core paint it was bringing
   * can no longer close, so it is drawn as it stands. Queued output is kept and written as before (#2794).
   */
  streamClosed(): void {
    if (this.#held.paint) this.#held.end();
  }

  /** Forgets queued output (the stream it came from is gone); its credit is not returned. A replay held ends. */
  drop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#queue = [];
    this.#update = new SynchronizedUpdate();
    this.#openedAt = null;
    this.#catchUp = null;
    this.#held.end();
    this.#replay.end();
  }

  /** How long a reply takes over this link: 1.5 x SRTT + 50 ms. */
  #roundTrip(): number {
    return 1.5 * (this.#srtt() ?? 0) + 50;
  }

  #startCatchUp(): void {
    this.#catchUp = { budget: Math.max(this.#queued(), CATCHUP_FRAME_BYTES), written: 0 };
  }

  /** A frame's budget: a catch-up frame's while catching up a backlog, else a frame's bytes. */
  #frameBudget(): number {
    const catchUp = this.#catchUp;
    if (catchUp === null) return FRAME_BYTES;
    if (catchUp.written < catchUp.budget && this.#queued() > CATCHUP_THRESHOLD) return CATCHUP_FRAME_BYTES;
    this.#catchUp = null;
    return FRAME_BYTES;
  }

  #onTime(ms: number, then: () => void, again: () => void): () => void {
    return onTime({ clock: this.#clock, timer: this.#timer, lastBytes: () => this.#lastBytes }, ms, then, again);
  }

  /** Inside a synchronized update whose paint is held, or an attach replay: written as it arrives. */
  #unpaced(): boolean {
    return this.#replay.active || this.#held.active;
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
      const budget = this.#frameBudget();
      const written = this.#flush(budget);
      if (budget === CATCHUP_FRAME_BYTES && this.#catchUp !== null) this.#catchUp.written += written;
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
   * where the update or replay ends, for the frame to go on. Returns how much it wrote.
   */
  #flush(budget: Budget): number {
    const parts: Uint8Array[] = [];
    const credits: [(bytes: number) => void, number][] = [];
    const limit = budget === "arrived" ? 0 : budget;
    let size = 0;
    // Whether this batch opens, continues or ends inside a synchronized update: the update holds the paint for it.
    let synchronized = this.#update.open;
    // Whether any of it is a program's output, not only a shell's answer to a resize (#2922).
    let drawn = false;
    while (this.#queue.length > 0) {
      const unpaced = this.#unpaced();
      if (!unpaced && size >= limit) break;
      const head = this.#queue[0];
      if (head === undefined) break;
      drawn ||= !head.answer;
      const room = unpaced ? head.bytes.byteLength : Math.min(head.bytes.byteLength, limit - size);
      // Read up to where an open update ends: what follows it is paced again.
      const take = this.#update.advance(head.bytes.subarray(0, room));
      // An update that opened and closed within this chunk still bracketed what it held.
      if (this.#update.opened) synchronized = true;
      if (!this.#update.open) {
        this.#openedAt = null;
        // Closed (in this chunk or an earlier one): it is drawn whole, and what follows it is paced.
        this.#held.end();
      } else {
        synchronized = true;
        if (this.#openedAt === null) {
          this.#openedAt = this.#clock();
          this.#held.start(this.#replay.active && this.#replay.written === 0 && size === 0 && opensUpdate(head.bytes));
        }
      }
      parts.push(take === head.bytes.byteLength ? head.bytes : head.bytes.subarray(0, take));
      credits.push([head.credit, take]);
      size += take;
      if (take === head.bytes.byteLength) this.#queue.shift();
      else this.#queue[0] = { ...head, bytes: head.bytes.subarray(take) };
    }
    if (size === 0) return 0;
    const batch = parts.length === 1 ? (parts[0] ?? new Uint8Array()) : concat(parts, size);
    this.#write(batch);
    for (const [credit, bytes] of credits) credit(bytes);
    for (const listener of this.#written) listener();
    // The core sends the next window of an update once this one's credit is back, after the write (#2011).
    if (this.#held.paint) this.#held.wrote(size);
    else if (drawn) this.#held.drawing();
    // Its hold began in the loop above, before the replay's ends, so the paint is never let go between them (#2040).
    this.#replay.wrote(size, synchronized);
    return size;
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
