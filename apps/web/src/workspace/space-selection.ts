import { createContext, use } from "react";
import type { ListedSpace } from "./model.ts";

/** The spaces of the layout documents, the one selected (the tab in view's `spaceKey`), and how to select another. */
export interface SpaceSelection {
  readonly spaces: readonly ListedSpace[];
  readonly selected: string | null;
  readonly select: (key: string) => void;
  /** Moves space `key` to index `to` among its machine's spaces; a refused write is a notice, never a rejection. */
  readonly move: (key: string, to: number) => void;
  /** The permanent ids of the machines whose layout is read and takes edits now: only their spaces are known gone. */
  readonly readCores?: readonly string[];
}

export const SpaceSelectionContext = createContext<SpaceSelection>({
  spaces: [],
  selected: null,
  select: () => {},
  move: () => {},
});

export const useSpaceSelection = (): SpaceSelection => use(SpaceSelectionContext);
