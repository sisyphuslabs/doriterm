import { createContext, useContext } from "react";

/** Closing spaces, for the sidebar: ask with the question that ends a space's tabs. */
export interface SpaceClosing {
  /** Opens the Close space question for space `id` (a `spaceKey`). */
  readonly ask: (id: string) => void;
  /** Why space `id` cannot be closed now (its layout takes no edits), or null when it can: the menu offers it disabled. */
  readonly refusal: (id: string) => string | null;
  /**
   * Why space `id`'s layout takes no edits now (its machine cannot take them), or null: what New tab in the space waits
   * on. A space no longer in the layout refuses Close but is no wait for its machine.
   */
  readonly editWait: (id: string) => string | null;
}

const NOT_PROVIDED: SpaceClosing = { ask: () => undefined, refusal: () => null, editWait: () => null };

export const SpaceCloseContext = createContext<SpaceClosing>(NOT_PROVIDED);

export const useSpaceClosing = (): SpaceClosing => useContext(SpaceCloseContext);
