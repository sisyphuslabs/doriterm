/** The part of a terminal stream that makes its viewer the one whose size the host takes. */
export interface SizedStream {
  resize(cols: number, rows: number): boolean;
  focus(gained: boolean): boolean;
}

export interface GridSize {
  readonly cols: number;
  readonly rows: number;
}

/** The view's grid: fitted to its box while `autoResize` is on, or held at a size it is given (wterm's WTerm). */
export interface ViewGrid extends GridSize {
  autoResize: boolean;
  resize(cols: number, rows: number): void;
  fit(): void;
}

/** Fits the grid to its box unless it holds the pty's size. */
export function fitGrid(view: ViewGrid): void {
  if (view.autoResize) view.fit();
}

/**
 * Fits the grid to the view's own box, held or not: the size an attach asks for. The core gives it the pty only when no
 * other viewer is more recently active (viewers.rs `apply_size`), so a phone alone on a terminal sizes it, and one
 * watching a desk's draws at the desk's size again once the answer and the core's size events say so.
 */
export function fitOwnBox(view: ViewGrid): void {
  view.autoResize = true;
  view.fit();
}

/**
 * When this view's grid may size the host's pty (redesign D1, as Herdr mobile does). herdr-core makes a viewer the size
 * leader when it types, resizes or gains focus, and an attach with `resumed: true` joins without taking the lead
 * (herdr-core viewers.rs `touch`, `active_at`). So a touch view only watching attaches that way and holds its RESIZE and
 * FOCUS frames: the desk that is typing keeps its columns, and a terminal no other viewer is on takes the phone's own
 * size from its attach (the core's leader is then the phone, active or not). The program draws for the pty's grid, so the watching view
 * draws at that grid too, not one fitted to its own box: a narrower grid wraps the program's rows, and each redraw that
 * goes back up by the program's own row count leaves the wrapped pieces behind (#2819's copies, #2974). Its first
 * input fits the grid to its box again and sends that size and focus ahead of the input, and from then on it sizes the
 * host as any view does.
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

  /** The pty's size as the core has it (the attach's answer, then each core RESIZE): a watching view draws at it. */
  ptySized(view: ViewGrid, size: GridSize): void {
    if (!this.#watching) return;
    view.autoResize = false;
    if (view.cols !== size.cols || view.rows !== size.rows) view.resize(size.cols, size.rows);
  }

  /** Called before each person's input is sent: the first one makes this view the one in use. */
  inputStarts(stream: SizedStream | null, view: ViewGrid): void {
    if (!this.#watching) return;
    // Fitted while still watching, so the grid's own resize is not sent ahead of the size below.
    fitOwnBox(view);
    this.#watching = false;
    this.#send(stream, this.#held ?? { cols: view.cols, rows: view.rows });
    if (this.#focused) stream?.focus(true);
  }
}
