/** Runs notifications moves one at a time, in the order asked; a move that throws does not stop the ones after it (#780). */
export class MoveQueue {
  #tail: Promise<void> = Promise.resolve();

  /** Settles once every move asked so far is done, whether it succeeded or threw. */
  get idle(): Promise<void> {
    return this.#tail;
  }

  /** Starts `move` once the move before it is done; the caller gets this move's own result, its failure included. */
  run(move: () => Promise<void>): Promise<void> {
    const moved = this.#tail.then(move);
    this.#tail = moved.catch(() => undefined);
    return moved;
  }
}
