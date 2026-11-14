import { createContext, useContext } from "react";

/** Closing spaces, for the sidebar: ask with the question that ends a space's tabs. */
export interface SpaceClosing {
  /** Opens the Close space question for space `id` (a `spaceKey`). */
  readonly ask: (id: string) => void;
  /** Why space `id` cannot be closed now (its layout takes no edits), or null when it can: the menu offers it disabled. */
  readonly refusal: (id: string) => string | null;
  /** Why New tab cannot start a terminal in space `id` now (its machine is offline), or null when it can (#2569). */
  readonly newRefusal: (id: string) => string | null;
}

const NOT_PROVIDED: SpaceClosing = { ask: () => undefined, refusal: () => null, newRefusal: () => null };

export const SpaceCloseContext = createContext<SpaceClosing>(NOT_PROVIDED);

export const useSpaceClosing = (): SpaceClosing => useContext(SpaceCloseContext);
