import type { TerminalInput } from "./terminal-view-props.ts";

export interface InputOrder {
  /** Writes `data` now, or behind input whose bytes are not known yet. */
  readonly send: (data: TerminalInput) => void;
  /**
   * Input known only once `data` settles (Paste image's ^V waits for the clipboard), null for none: what is sent
   * meanwhile waits behind it, so a key typed after Ctrl+V reaches the program after its ^V. A `data` that rejects is
   * reported and counts as none.
   */
  readonly later: (data: Promise<TerminalInput | null>) => void;
}

/** Input written in the order it was given, as herdr-app's synchronous key handling writes it. */
export function inputOrder(write: (data: TerminalInput) => void): InputOrder {
  let behind: Promise<void> | null = null;
  const queue = (step: () => void | Promise<void>): void => {
    // A step that fails is reported, and the input queued behind it still goes out, in order (#1988).
    const link: Promise<void> = (behind ?? Promise.resolve())
      .then(step)
      .catch((error: unknown) => console.error(`terminal input: ${String(error)}`))
      .finally(() => {
        if (behind === link) behind = null;
      });
    behind = link;
  };
  return {
    send: (data) => (behind === null ? write(data) : queue(() => write(data))),
    later: (data) =>
      queue(async () => {
        const known = await data;
        if (known !== null) write(known);
      }),
  };
}
