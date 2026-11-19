// What the core's layout document and the sidebar say about a terminal's tab, for specs that check the tabs follow the
// core's terminals however they were started, moved, renamed or removed.
import type { Page } from "@playwright/test";
import { getCoreDoc } from "./core-doc.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";

export interface DocTab {
  readonly id: string;
  readonly name: string;
  readonly root: unknown;
}
export interface DocSpace {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly tabs: readonly DocTab[];
}

/** The sidebar row of the space with that name. */
export const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** The names of the spaces whose tabs show the terminal, in the saved layout of its core. */
export function spacesShowing(address: string, on?: string): string[] {
  const doc = getCoreDoc(LAYOUT_DOC, on) as { spaces?: readonly DocSpace[] } | null;
  return (doc?.spaces ?? []).flatMap((space) =>
    space.tabs.filter((tab) => JSON.stringify(tab.root).includes(`"terminal":"${address}"`)).map(() => space.name),
  );
}
