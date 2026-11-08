export interface SpaceTab {
  readonly key: string;
  readonly spaceKey: string;
  readonly panes: readonly { readonly address: string | null }[];
}

/**
 * The terminal a space row opens on a phone (#1387). A desktop row only moves the selected space; a phone shows one
 * terminal at a time and reads it from the route, so the row has to name the terminal it means: the tab the space showed
 * last, else its first.
 */
export function spaceRowTarget(tabs: readonly SpaceTab[], shownTabKey: string | null, spaceKey: string): string | null {
  const inSpace = tabs.filter((tab) => tab.spaceKey === spaceKey);
  const tab = inSpace.find((each) => each.key === shownTabKey) ?? inSpace[0];
  return tab?.panes.find((pane) => pane.address !== null)?.address ?? null;
}
