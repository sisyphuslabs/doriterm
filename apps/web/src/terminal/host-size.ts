/** The part of a terminal stream that makes its viewer the one whose size the host takes. */
export interface SizedStream {
  resize(cols: number, rows: number): boolean;
  focus(gained: boolean): boolean;
}

export interface GridSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * When this view's grid may size the host's pty (redesign D1, as Herdr mobile does). herdr-core makes a viewer the size
 * leader when it types, resizes or gains focus, and an attach with `resumed: true` joins without taking the lead
 * (herdr-core viewers.rs `touch`, `active_at`). So a touch view only watching attaches that way and holds its RESIZE and
 * FOCUS frames: the desk that is typing keeps its columns, and the phone fits the output to its own grid. Its first
 * input sends its size and focus ahead of the input, and from then on it sizes the host as any view does.
 */
export class HostSize {
  #watching: boolean;
  #focused = false;
  /** The grid's latest size while a pinch holds it; null when nothing was held. */
  #held: GridSize | null = null;
  #holding = false;
  #sent: GridSize | null = null;

  constructor(deferred: boolean) {
    this.#watching = deferred;
  }

  /** Whether an attach now should join without taking the host's size. */
  attachDeferred(): boolean {
    return this.#watching;
  }

  resize(stream: SizedStream | null, cols: number, rows: number): void {
    if (this.#holding) this.#held = { cols, rows };
    else if (!this.#watching) this.#send(stream, { cols, rows });
  }

  /** A pinch is moving: the grid refits to each step here, and the host hears none of it (redesign section 7). */
  hold(): void {
    this.#holding = true;
  }

  /** The pinch is over: the size the grid settled on goes to the host once, if it changed. */
  release(stream: SizedStream | null): void {
    this.#holding = false;
    const held = this.#held;
    this.#held = null;
    if (held === null || this.#watching) return;
    if (held.cols !== this.#sent?.cols || held.rows !== this.#sent.rows) this.#send(stream, held);
  }

  #send(stream: SizedStream | null, grid: GridSize): void {
    if (stream?.resize(grid.cols, grid.rows) === true) this.#sent = grid;
  }

  focus(stream: SizedStream | null, gained: boolean): void {
    this.#focused = gained;
    if (!this.#watching || !gained) stream?.focus(gained);
  }

  /** Called before each person's input is sent: the first one makes this view the one in use. */
  inputStarts(stream: SizedStream | null, grid: GridSize): void {
    if (!this.#watching) return;
    this.#watching = false;
    this.#send(stream, this.#held ?? grid);
    if (this.#focused) stream?.focus(true);
  }
}
