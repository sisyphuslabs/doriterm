import { createContext, useContext } from "react";

/** Renaming spaces, for the sidebar: ask with the dialog, or check and write a name typed in place. */
export interface SpaceRenaming {
  /** Opens the Rename question for space `id`. */
  readonly ask: (id: string) => void;
  /** Why space `id` cannot be renamed now (its layout takes no edits), or null when it can: the menu offers it disabled. */
  readonly refusal: (id: string) => string | null;
  /** Why `name` cannot become space `id`'s name, or null when it can. */
  readonly problem: (id: string, name: string) => string | null;
  /** Writes the name in the space's layout document; rejects with why it was not written. */
  readonly rename: (id: string, name: string) => Promise<void>;
}

const NOT_PROVIDED: SpaceRenaming = {
  ask: () => undefined,
  refusal: () => "Spaces cannot be renamed here.",
  problem: () => "Spaces cannot be renamed here.",
  rename: () => Promise.reject(new Error("Spaces cannot be renamed here.")),
};

export const SpaceRenameContext = createContext<SpaceRenaming>(NOT_PROVIDED);

export const useSpaceRenaming = (): SpaceRenaming => useContext(SpaceRenameContext);
