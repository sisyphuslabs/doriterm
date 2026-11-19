import type { JsonObject } from "@doriface/protocol";
import {
  addTab,
  type Axis,
  docSpaces,
  editTab,
  freshId,
  idOf,
  type NewSpace,
  type Node,
  splitPane,
  terminalBlock,
} from "@doriface/protocol/layout";
import { type LayoutTab, localOf } from "./layout-model.ts";
import type { View } from "../layout/view.ts";
import { shownIn } from "./adoption.ts";

/** A tab root holding one terminal: a row `id` with the terminal `local` in pane `pane`. */
export const terminalRow = (id: string, pane: string, local: string): Node => ({
  children: [terminalBlock(pane, local)],
  id,
  type: "row",
});

/** The transient tab's terminal as a tab for the document, with fresh ids; both the new-tab and the split write use it. */
export function written(tab: LayoutTab): { id: string; pane: string; root: Node } {
  const id = freshId("tb");
  const pane = freshId("p");
  return { id, pane, root: terminalRow(id, pane, localOf(tab.panes[0]?.address ?? "")) };
}

/** A pane of a machine's document: its tab's id and its own. */
export interface PaneAt {
  readonly tab: string;
  readonly pane: string;
}

/** A tab this screen writes: its id and its root. */
export interface NewTab {
  readonly id: string;
  readonly root: Node;
}

/** The pane a split adds: which way, its block, and the id of the container it may need. */
export interface NewSplit {
  readonly axis: Axis;
  readonly block: Node;
  readonly container: string;
}

/** What to save (null: nothing), and where the view goes instead of where it was asked to (null: where it was asked). */
export interface PaneWrite {
  readonly doc: JsonObject | null;
  readonly instead: PaneAt | null;
}

/** keepApart's write: the first live terminal shown alone, as a tab of a new space; nothing once a tab shows it. */
export function apartWrite(doc: JsonObject | null, terminal: string, tab: NewTab, space: NewSpace): JsonObject | null {
  return shownIn(doc, terminal) === null ? addTab(doc, space, { id: tab.id, name: "", root: tab.root }) : null;
}

/**
 * A new tab's write for `terminal`, after `after`, with the transient tab it keeps (`kept`) written before it. Nothing
 * when a tab already shows the terminal, and the view goes there. A kept tab whose terminal a tab already shows is not
 * written: the new tab then goes right after that tab, in its space, when it `follows` the tab in view (#2231), else
 * into `space` (a new space or a named one it was asked for).
 */
export function newTabWrite(
  doc: JsonObject | null,
  terminal: string,
  tab: JsonObject,
  space: NewSpace,
  after: string | undefined,
  kept: { readonly terminal: string; readonly tab: NewTab; readonly follows: boolean } | null,
  pins?: ReadonlySet<string>,
): PaneWrite {
  const instead = shownIn(doc, terminal);
  if (instead !== null) return { doc: null, instead };
  const adopted = kept === null ? null : shownIn(doc, kept.terminal);
  // The kept tab was adopted while this write waited: the new tab goes right after the tab that adopted it, in its space
  // (#2231), as herdr-app's `add_tab` puts a tab after the selected one.
  const home =
    adopted === null || doc === null ? undefined : docSpaces(doc).find((each) => each.tabs.includes(adopted.tab));
  if (home !== undefined && adopted !== null && kept?.follows === true) {
    return {
      doc: addTab(doc, { id: home.id, folder: home.folder, name: home.name }, tab, adopted.tab, pins),
      instead: null,
    };
  }
  const keep = kept !== null && adopted === null ? kept.tab : null;
  const first = keep === null ? doc : addTab(doc, space, { id: keep.id, name: "", root: keep.root });
  return { doc: addTab(first, space, tab, keep?.id ?? after, pins), instead: null };
}

/**
 * The split of the transient tab, whose terminal (`source`) no document holds yet: its tab is written with the new pane
 * beside its own. Nothing when a tab already shows the new terminal, and the view goes there. When a tab already shows
 * `source`, the new pane goes beside that pane in that tab instead.
 */
export function transientSplitWrite(
  doc: JsonObject | null,
  source: string,
  terminal: string,
  copy: NewTab & { readonly pane: string },
  split: NewSplit,
  space: NewSpace,
): PaneWrite {
  const shown = shownIn(doc, terminal);
  if (shown !== null) return { doc: null, instead: shown };
  const placed = (root: Node): Node | null => splitPane(root, copy.pane, split.axis, split.block, split.container);
  const there = shownIn(doc, source);
  if (there === null || doc === null) {
    const root = placed(copy.root);
    return { doc: root === null ? null : addTab(doc, space, { id: copy.id, name: "", root }), instead: null };
  }
  const beside = (root: Node): Node | null => splitPane(root, there.pane, split.axis, split.block, split.container);
  return { doc: editTab(doc, there.tab, beside), instead: { tab: there.tab, pane: idOf(split.block) } };
}

/**
 * A split's write: the new pane beside `from` in the tab `tab`. Nothing when a tab already shows the new terminal, and
 * the view goes there; nothing either when `from` is gone (`gone`: it closed on another device first).
 */
export function splitWrite(
  doc: JsonObject | null,
  tab: string,
  from: string,
  terminal: string,
  split: NewSplit,
): PaneWrite & { readonly gone: boolean } {
  const instead = shownIn(doc, terminal);
  if (instead !== null) return { doc: null, instead, gone: false };
  const next =
    doc === null ? null : editTab(doc, tab, (root) => splitPane(root, from, split.axis, split.block, split.container));
  return { doc: next, instead: null, gone: next === null };
}

/**
 * The view once the pane asked for (`asked`, in the tab keyed `key`) is shown at `at` instead. The person still on the
 * tab asked for goes to `at`, as a new tab whose terminal was adopted meanwhile does (#2122); anyone who moved on stays.
 * The tab asked for focuses `back` again (the pane it focused), not a pane that was never written.
 */
export function viewInstead(
  view: View,
  asked: { readonly key: string; readonly pane: string },
  at: { readonly key: string; readonly pane: string },
  back: string | null,
): View {
  const focused =
    back !== null && view.focused[asked.key] === asked.pane ? { ...view.focused, [asked.key]: back } : view.focused;
  if (view.active !== asked.key) return focused === view.focused ? view : { ...view, focused };
  return { ...view, active: at.key, focused: { ...focused, [at.key]: at.pane } };
}
