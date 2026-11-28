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
function fitOwnBox(view: ViewGrid): void {
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
 *
 * A watching view the core gave its own size (no other viewer is on the terminal, or none more recently active) leads the
 * pty already: it keeps fitting its box and sends each new size, so a box that settles after the attach (the web font
 * arriving, a phone's viewport settling, a rotation, a return from the background) sizes the grid and the pty with no
 * input (#2987). It knows it leads when the pty's size is one it gave the core.
 */
export class HostSize {
  #watching: boolean;
  #focused = false;
  /** The grid's latest size while a pinch holds it; null when nothing was held. */
  #held: GridSize | null = null;
  #holding = false;
  #sent: GridSize | null = null;
  /** While watching: the sizes this view gave the core (its attach, then its resizes), the core's latest one first. */
  #given: GridSize[] = [];
  /** While watching or in the background: the pty's size is one this view gave the core, so its own sizes reach it. */
  #leads = false;
  /**
   * A desk view reattached with `resumed: true` and not in use: the core gives it the pty only while no other viewer is
   * more recently active, and every RESIZE is activity to the core (viewers.rs `touch`). So it holds its sizes until it is
   * focused, unless it leads, and the device in use keeps its size (#2390).
   */
  #background = false;
  /** In the background: the grid's latest size the core has not been given, sent with its focus. */
  #unsent: GridSize | null = null;

  constructor(deferred: boolean) {
    this.#watching = deferred;
  }

  /** Whether an attach now should join without taking the host's size. */
  attachDeferred(): boolean {
    return this.#watching;
  }

  /** An attach is sent: it asks for the view's own box, which the core gives it unless another viewer leads (D1). */
  asks(view: ViewGrid): GridSize {
    fitOwnBox(view);
    const asked = { cols: view.cols, rows: view.rows };
    this.#given = [asked];
    this.#leads = false;
    return asked;
  }

  /** Whether this view's sizes wait for the view to be used: while watching or in the background. */
  #deferred(): boolean {
    return this.#watching || this.#background;
  }

  #sizesHost(): boolean {
    return !this.#deferred() || this.#leads;
  }

  resize(stream: SizedStream | null, cols: number, rows: number): void {
    if (this.#holding) this.#held = { cols, rows };
    else if (this.#sizesHost()) this.#send(stream, { cols, rows });
    else if (this.#background) this.#unsent = { cols, rows };
  }

  /**
   * The core answered an attach with the pty's size. A reattach after a reconnect names whether the view is in use (the
   * focused pane, in a focused window): that one was the active viewer before the drop, and its FOCUS makes it so again,
   * so the core applies its size now. One in the background sends no FOCUS, which would report focus-in to its program,
   * and no size while another viewer leads (#2390). A fit while the attach was in flight goes as any resize does.
   */
  attached(
    stream: SizedStream,
    view: ViewGrid,
    answer: { readonly asked: GridSize; readonly size: GridSize; readonly reattach: "in use" | "background" | null },
  ): void {
    this.#background = answer.reattach === "background" && !this.#watching;
    this.#unsent = null;
    this.ptySized(stream, view, answer.size);
    if (answer.reattach === "in use") this.focus(stream, true);
    if (view.cols !== answer.asked.cols || view.rows !== answer.asked.rows) this.resize(stream, view.cols, view.rows);
  }

  /**
   * The page is shown again (another app, the phone unlocked, a page restored from the back-forward cache): the grid
   * fits the box it has now, as any change of the box does, and a view in use gives the program its size again (#2819).
   * A watching view takes nothing back; it sends only a size its fit changed, and only while it leads.
   */
  shown(stream: SizedStream | null, view: ViewGrid): void {
    fitGrid(view);
    if (!this.#watching) this.resize(stream, view.cols, view.rows);
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
    if (held === null) return;
    if (!this.#sizesHost()) {
      if (this.#background) this.#unsent = held;
      return;
    }
    if (held.cols !== this.#sent?.cols || held.rows !== this.#sent.rows) this.#send(stream, held);
  }

  #send(stream: SizedStream | null, grid: GridSize): void {
    if (stream?.resize(grid.cols, grid.rows) !== true) return;
    this.#sent = grid;
    if (this.#deferred()) this.#given.push(grid);
  }

  /** The size held in the background goes first, so the focus that makes this view active applies it (#2390). */
  #sendUnsent(stream: SizedStream | null): void {
    const unsent = this.#unsent;
    this.#unsent = null;
    if (unsent !== null) this.#send(stream, unsent);
  }

  focus(stream: SizedStream | null, gained: boolean): void {
    this.#focused = gained;
    if (gained && this.#background) {
      this.#background = false;
      this.#sendUnsent(stream);
    }
    if (!this.#watching || !gained) stream?.focus(gained);
  }

  /**
   * The pty's size as the core has it (the attach's answer, then each core RESIZE). A watching view that gave the core
   * this size leads: its grid follows its own box. Any other size is another viewer's, which a watching view draws at.
   */
  ptySized(stream: SizedStream | null, view: ViewGrid, size: GridSize): void {
    if (!this.#deferred()) return;
    const mine = this.#given.findIndex((given) => given.cols === size.cols && given.rows === size.rows);
    this.#leads = mine >= 0;
    if (this.#background) {
      // A desk's grid is its own: leading again (the other viewer left), it gives the core what it held meanwhile.
      if (!this.#leads) {
        this.#given = this.#given.slice(-1);
        return;
      }
      this.#given = this.#given.slice(mine);
      this.#sendUnsent(stream);
      return;
    }
    if (this.#leads) {
      // Sizes sent before this one are behind the core now.
      this.#given = this.#given.slice(mine);
      fitOwnBox(view);
      return;
    }
    // The core keeps the last size this view gave it, which it applies again once this view leads.
    this.#given = this.#given.slice(-1);
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
