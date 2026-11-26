/**
 * Input the renderer gives on its own, not on the person's behalf: its answers to a program's queries, given inside a
 * write of output (@wterm/dom's `write` drains them into onData), and the focus reports its field gives as it gains or
 * loses focus (a program that asked for them gets one on any focus change, the page's own included). They reach the
 * same onData as typed keys, so they are told apart where they are given, never by their bytes (#2794).
 */
export class RendererAnswers {
  #depth = 0;

  /** Whether input given now is the renderer's own. */
  get answering(): boolean {
    return this.#depth > 0;
  }

  /** Runs `write` (output to the renderer); what the renderer gives meanwhile is its own. */
  writing(write: () => void): void {
    this.#depth += 1;
    try {
      write();
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * Counts the focus reports `field` gives: from the capture of its focus or blur on `root`, which runs before the
   * renderer's own listener on the field, to a listener on the field added after the renderer's, which runs after it.
   * Returns how to stop.
   */
  focusReportsOf(root: EventTarget, field: EventTarget): () => void {
    const opened = (event: Event): void => {
      if (event.target === field) this.#depth += 1;
    };
    const closed = (): void => {
      this.#depth -= 1;
    };
    for (const type of ["focus", "blur"]) {
      root.addEventListener(type, opened, true);
      field.addEventListener(type, closed);
    }
    return () => {
      for (const type of ["focus", "blur"]) {
        root.removeEventListener(type, opened, true);
        field.removeEventListener(type, closed);
      }
    };
  }
}
