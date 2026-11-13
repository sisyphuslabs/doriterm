import type { Terminal } from "@doriface/protocol";
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Axis,
  type DocEdit,
  freshId,
  renameTab as renameDocTab,
  closeSet,
  pinEdit,
  placePinned,
  terminalBlock,
} from "@doriface/protocol/layout";
import { loadView, rememberSeen, saveView, tabKey, type Seen, type View } from "../layout/view.ts";
import { type PaneAt, splitWrite, transientSplitWrite, viewInstead } from "./pane-writes.ts";
import {
  buildTabs,
  landingPane,
  layoutIds,
  localOf,
  looseKey,
  pick,
  spaceTabs,
  TRANSIENT,
  type LayoutPane,
  type LayoutTab,
  keepMounts,
  newMounts,
} from "./layout-model.ts";
import { tabAddress, tabKey as terminalKey } from "./tab-keys.ts";
import { usePaneMoves, type PaneMoves } from "./use-pane-moves.ts";
import { splitLanding } from "./split-landing.ts";
import type { TabMove } from "./tab-order.ts";
import type { Leaving } from "./use-drop-pane.ts";
import { useTabClose } from "./use-tab-close.ts";
import { useTabOpening, written } from "./use-tab-opening.ts";
import { useTabMoves } from "./use-tab-moves.ts";
import { LAYOUT_LOADING, type MachineLayout } from "./use-layout-docs.ts";

export interface Layout extends PaneMoves {
  /** Every tab of every machine's document, and this screen's own. */
  readonly tabs: readonly LayoutTab[];
  /** The tab bar's tabs: the selected space's (the space of the tab in view), in their document's order (#404). */
  readonly shown: readonly LayoutTab[];
  /** Shows the space `key` (`spaceKey`) on the tab it showed last, else its first tab. */
  readonly selectSpace: (key: string) => void;
  readonly active: LayoutTab | null;
  readonly focused: LayoutPane | null;
  readonly zoomed: string | null;
  readonly selectTab: (key: string) => void;
  readonly focusPane: (tab: string, pane: string) => void;
  /**
   * Focuses the pane that shows the terminal, or opens it in a new tab: in the selected space, after its tab in view,
   * when the terminal is on that space's machine; else, or with `newSpace`, as the first tab of a new space. With `space`
   * (a `spaceKey` of the terminal's machine) the new tab goes into that space, also one with no tab to select.
   */
  readonly openTerminal: (address: string, newSpace?: boolean, space?: string) => void;
  /**
   * Focuses the pane that shows the terminal, or opens it in a new tab in the space adoption would put it in (`placeOf`:
   * its labels, else its folder, else Home), so an agent picked from a list before its adoption lands where it belongs.
   */
  readonly placeTerminal: (address: string) => void;
  /** Puts a terminal started for a pane (the focused one unless `target` names another) beside it, and focuses it. */
  readonly split: (axis: Axis, address: string, target?: PaneTarget, pane?: string) => void;
  /** Takes the terminal's pane out of its tab, and the tab when it was the last pane; the terminal is untouched. */
  readonly dropPane: (address: string) => void;
  readonly closeTab: (key: string) => void;
  /** The pane this screen split off last, which grows in from the pane it came from. */
  readonly fresh: string | null;
  /**
   * The finishes this screen has already looked at, by terminal address (herdr-app's seen attention in its `view.json`):
   * an agent listed here whose finish that was reads idle instead of done (#611).
   */
  readonly seen: Seen;
  /** Records finishes this screen has shown; a finish already recorded is not written again. */
  readonly remember: (marks: Seen) => void;
  /**
   * The pane this screen last asked for (opened, split, focused, picked its tab): its terminal takes the keyboard as it
   * starts. A pane only another device's layout edit brought or moved here is not one (#332).
   */
  readonly claimed: string | null;
  /** Moves a tab so it ends at index `to` of `shown`, in its space's document; panes and focus stay as they are. */
  readonly moveTab: (key: string, to: number) => void;
  /**
   * Names a tab in its document, as herdr-app's `tab.rename` ("": named by its focused pane again), so every device shows
   * it; rejects with why when the tab is not in a document that takes edits, or the write fails.
   */
  readonly renameTab: (key: string, name: string) => Promise<void>;
  /**
   * Pins a tab in front of its space's others, or unpins it (#1561): the pin goes in the machine's pins document, which
   * every device reads and herdr-app leaves alone, and the tab moves to its side in the herdr-app document.
   */
  readonly pinTab: (key: string, pinned: boolean) => Promise<void>;
  /** The keys "Close tabs to the right" or "Close other tabs" closes from a tab: never a pinned one (#1561). */
  readonly closeSetOf: (key: string, which: "right" | "others") => readonly string[];
  /** The last tab moved, counted so the strip can say where it went each time, even to the same place twice. */
  readonly lastMove: TabMove | null;
  /**
   * machine.list has answered and every machine's layout has been read, or cannot be: the tabs on screen are all the
   * documents hold, so a tab showing up now is an arrival, not the restored screen.
   */
  readonly restored: boolean;
}

export interface PaneTarget {
  readonly tab: string;
  readonly pane: string;
}

const HISTORY = 32;

/** `now` with `gone` back where it was in `had`: before the first pane that came after it there and is still in `now`. */
function putBack(now: readonly string[], had: readonly string[], gone: string): string[] {
  if (now.includes(gone)) return [...now];
  const after = new Set(had.slice(had.indexOf(gone) + 1));
  const at = now.findIndex((id) => after.has(id));
  return (at === -1 ? [...now, gone] : now.toSpliced(at, 0, gone)).slice(-HISTORY);
}

/** Set while a placement runs without claiming its pane (see `withoutClaim`). */
let placingQuietly = false;

/**
 * Runs `place` (an open, a new tab, a split) without this screen claiming the pane it shows: for a terminal whose start
 * answered after the person moved on, so its view does not take the keyboard from what they turned to (#360).
 */
export function withoutClaim(place: () => void): void {
  placingQuietly = true;
  try {
    place();
  } finally {
    placingQuietly = false;
  }
}

export function useLayout(
  core: string,
  layouts: readonly MachineLayout[],
  terminals: readonly Terminal[],
  failed: (message: string) => void,
  told: (message: string) => void,
  /** This screen's selected tabs and focus could not be saved for the next reload; said once until a save works again. */
  unsaved: (message: string) => void,
  /** machine.list has answered since the workspace mounted, so every added machine's layout is known. */
  machinesListed = true,
): Layout {
  const [view, setView] = useState<View>(() => loadView(core));
  const [fresh, setFresh] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);
  // A finish this screen has shown is noted with what it asked from (its turn, or when it finished), so the agent stops
  // asking here and the next finish asks again; one already noted is not written, so looking at an agent stops there.
  const remember = useCallback((marks: Seen): void => setView((prev) => rememberSeen(prev, marks)), []);
  // Read through a ref: the toast it raises re-renders the workspace, which must not count as another write.
  const tellUnsaved = useRef(unsaved);
  tellUnsaved.current = unsaved;
  const refused = useRef(false);
  useEffect(() => {
    const reason = saveView(core, view);
    if (reason === null) {
      refused.current = false;
    } else if (!refused.current) {
      refused.current = true;
      tellUnsaved.current(reason);
    }
  }, [core, view]);
  // Terminals opened while their machine's layout took no edits; this screen shows them as tabs of its own. Each is kept
  // by what its terminal is remembered by (tab-keys.ts), as a document tab is, so a machine rename moves it to the new
  // address instead of leaving it on one that no longer exists (#459). `setLoose` takes and gives addresses.
  const [looseKeys, setLooseKeys] = useState<readonly string[]>([]);
  const ids = useMemo(() => layoutIds(layouts), [layouts]);
  const idsNow = useRef(ids);
  idsNow.current = ids;
  const loose = useMemo(
    () =>
      looseKeys.flatMap((key) => {
        const address = tabAddress(key, ids);
        return address === undefined ? [] : [address];
      }),
    [looseKeys, ids],
  );
  const setLoose = useCallback((change: SetStateAction<readonly string[]>): void => {
    setLooseKeys((keys) => {
      const now = idsNow.current;
      const held = keys.map((key) => ({ key, address: tabAddress(key, now) }));
      const before = held.flatMap(({ address }) => (address === undefined ? [] : [address]));
      const after = typeof change === "function" ? change(before) : change;
      // A key whose machine machine.list does not name now stays until it does.
      const kept = held.filter(({ address }) => address === undefined || after.includes(address)).map(({ key }) => key);
      const added = after.filter((address) => !before.includes(address)).map((address) => terminalKey(address, now));
      return [...kept, ...added];
    });
  }, []);
  const mounts = useRef(newMounts());
  const tabs = useMemo(
    () => keepMounts(buildTabs(layouts, terminals, loose), mounts.current, ids),
    [layouts, terminals, loose, ids],
  );
  const { active, focused, zoomed } = pick(tabs, view);
  // Read when a start answers, which can be after the person picked another tab: the tab in view now, not then.
  const activeNow = useRef(active);
  activeNow.current = active;
  // A document tab that took over the selected loose tab's view is the selected tab from now on, also after a reload.
  const takenOver = active !== null && active.key !== view.active && active.mount === view.active ? active.key : null;
  useEffect(() => {
    if (takenOver !== null) setView((prev) => ({ ...prev, active: takenOver }));
  }, [takenOver]);
  const shown = useMemo(() => spaceTabs(tabs, active), [tabs, active]);
  // Each space remembers the tab it showed, so picking the space again brings that tab back (herdr-app's `Space.active`).
  const remembered = active === null ? undefined : view.spaces[active.spaceKey];
  useEffect(() => {
    if (active === null || remembered === active.key) return;
    setView((prev) => ({ ...prev, spaces: { ...prev.spaces, [active.spaceKey]: active.key } }));
  }, [active, remembered]);
  const focusedIn = view.focused;
  const layoutOf = useCallback(
    (machine: string | null) => {
      const layout = layouts.find((each) => each.machine === machine);
      if (layout === undefined) return undefined;
      const edit = (change: DocEdit): Promise<boolean> =>
        layout.edit(change).catch((cause: unknown) => {
          failed(cause instanceof Error ? cause.message : String(cause));
          return false;
        });
      return { ...layout, edit };
    },
    [failed, layouts],
  );

  // Panes focused per tab, oldest first, as herdr-app's `before`: moving focus prefers the pane left last.
  const history = useRef(new Map<string, string[]>());
  const picked = useRef({ tabs, focused: view.focused });
  picked.current = { tabs, focused: view.focused };
  const show = useCallback((key: string, pane: string | null, select = true): void => {
    // Picking a tab claims the pane it focuses, so that terminal takes the keyboard from the tab left behind (#1704).
    const landing = pane ?? landingPane(picked.current.tabs, picked.current.focused, key);
    if (landing !== null && !placingQuietly) setClaimed(landing);
    if (pane !== null) {
      const visited = (history.current.get(key) ?? []).filter((id) => id !== pane);
      history.current.set(key, [...visited, pane].slice(-HISTORY));
    }
    setView((prev) => {
      // Focus leaving a zoomed pane shows every pane again, as herdr-app and Ghostty unzoom on a focus move or a split,
      // so focus never sits on a pane the zoom hides and a close never acts on one out of view.
      const { [key]: inTab, ...others } = prev.zoomed;
      return {
        ...prev,
        active: select ? key : prev.active,
        focused: pane === null ? prev.focused : { ...prev.focused, [key]: pane },
        zoomed: pane === null || inTab === undefined || inTab === pane ? prev.zoomed : others,
      };
    });
  }, []);

  /**
   * The pane asked for (`asked`) is shown at `there` in the document of the machine `machineId` instead: its terminal
   * was adopted while the write waited (pane-writes.ts). The view and the keyboard's claim follow it there.
   */
  const goInstead = useCallback(
    (
      machineId: string | null,
      asked: { readonly key: string; readonly pane: string },
      there: PaneAt,
      back: string | null,
    ): void => {
      const at = { key: tabKey(machineId, there.tab), pane: there.pane };
      setClaimed((claim) => (claim === asked.pane ? at.pane : claim));
      if (at.pane !== asked.pane) setFresh((was) => (was === asked.pane ? null : was));
      setView((prev) => viewInstead(prev, asked, at, back));
    },
    [],
  );

  /** A tab of this screen's own for a terminal its machine's layout could not take. */
  const keepHere = useCallback(
    (address: string): void => {
      setLoose((prev) => (prev.includes(address) ? prev : [...prev, address]));
      show(looseKey(address, idsNow.current), TRANSIENT);
    },
    [setLoose, show],
  );

  const { addTab, openTerminal, placeTerminal } = useTabOpening({
    active,
    tabs,
    terminals,
    layoutOf,
    show,
    goInstead,
    keepHere,
    setLoose,
  });
  const selectSpace = useCallback(
    (key: string): void => {
      const inSpace = tabs.filter((tab) => tab.spaceKey === key);
      const target = inSpace.find((tab) => tab.key === view.spaces[key]) ?? inSpace[0];
      if (target !== undefined) show(target.key, null);
    },
    [show, tabs, view.spaces],
  );

  const split = useCallback(
    (axis: Axis, address: string, target?: PaneTarget, made: string = freshId("p")): void => {
      const tab = target === undefined ? active : (tabs.find((each) => each.key === target.tab) ?? null);
      // A named pane may not be on screen yet (a split still being written); the document edit finds it.
      const from = target === undefined ? focused : { id: target.pane };
      if (tab === null || from === null) return addTab(address);
      const layout = layoutOf(tab.machine);
      if (layout === undefined || layout.readOnly !== null) return undefined;
      const pane = made;
      const block = terminalBlock(pane, localOf(address));
      const container = freshId("s");
      // Where the document shows the new pane instead of where it was asked, its terminal (or, for the transient tab,
      // the terminal it split) adopted while this write waited (#2122, #2146): the view goes there.
      let adopted: PaneAt | null = null;
      if (tab.transient) {
        const copy = written(tab);
        const space = { id: freshId("spc"), folder: "" };
        const source = localOf(tab.panes[0]?.address ?? "");
        const asked = tabKey(layout.machineId, copy.id);
        void layout
          .edit((doc) => {
            const write = transientSplitWrite(doc, source, localOf(address), copy, { axis, block, container }, space);
            adopted = write.instead;
            return write.doc;
          })
          .then((placed) => {
            const there = adopted;
            if (there !== null) goInstead(layout.machineId, { key: asked, pane }, there, null);
            return placed;
          });
        setFresh(pane);
        // The terminal starts asynchronously: a start that answers after the person picked another tab still places
        // its pane here, but their pick stays in view (#1539).
        return show(asked, pane, tab.key === activeNow.current?.key);
      }
      // Whether the edit last found the pane gone; a write that failed instead was already reported by `edit`.
      let gone = false;
      void layout
        .edit((doc) => {
          const write = splitWrite(doc, tab.id, from.id, localOf(address), { axis, block, container });
          gone = write.gone;
          adopted = write.instead;
          return write.doc;
        })
        .then((placed) => {
          const there = adopted;
          if (there !== null) {
            goInstead(layout.machineId, { key: tab.key, pane }, there, from.id);
            return placed;
          }
          const landing = splitLanding(placed, gone);
          if (landing === "own-tab") {
            addTab(address);
            told("The pane you split had closed, so the new terminal opened in a new tab.");
          }
          if (landing === "here") keepHere(address);
          return placed;
        });
      setFresh(pane);
      // The terminal starts asynchronously: a start that answers after the person picked another tab still places
      // its pane in this tab, but their pick stays in view (#1539).
      return show(tab.key, pane, tab.key === activeNow.current?.key);
    },
    [active, addTab, focused, goInstead, keepHere, layoutOf, show, tabs, told],
  );

  // As herdr-app's remove_pane: focus goes back to the pane focused before the closed one that is still there. A write
  // that fails puts the pane back: in its old place in the focus history, and focus with it only when this took focus
  // off it and nothing has moved focus since.
  const leavePane = useCallback(
    (leaving: Leaving): (() => void) => {
      const key = leaving.tab.key;
      const gone = leaving.pane.id;
      const had = history.current.get(key) ?? [];
      const left = had.filter((id) => id !== gone);
      history.current.set(key, left);
      const here = new Set(leaving.tab.panes.map((pane) => pane.id));
      const before = left.findLast((id) => here.has(id));
      const moved = before !== undefined && focusedIn[key] === gone;
      if (moved)
        setView((prev) =>
          prev.focused[key] === gone ? { ...prev, focused: { ...prev.focused, [key]: before } } : prev,
        );
      return () => {
        if (had.includes(gone)) history.current.set(key, putBack(history.current.get(key) ?? [], had, gone));
        if (moved)
          setView((prev) =>
            prev.focused[key] === before ? { ...prev, focused: { ...prev.focused, [key]: gone } } : prev,
          );
      };
    },
    [focusedIn],
  );
  const { dropPane, closeTab } = useTabClose(tabs, active, view.spaces, layoutOf, setLoose, setView, leavePane);

  const moves = usePaneMoves({ active, focused, layoutOf, show, setView, history: history.current });
  const selectTab = useCallback((key: string): void => show(key, null), [show]);
  const focusPane = useCallback((tab: string, pane: string): void => show(tab, pane), [show]);
  const { moveTab, lastMove } = useTabMoves(shown, layoutOf);
  const renameTab = useCallback(
    async (key: string, name: string): Promise<void> => {
      const tab = tabs.find((each) => each.key === key);
      const layout = tab === undefined ? undefined : layouts.find((each) => each.machine === tab.machine);
      if (tab === undefined || tab.transient || layout === undefined) throw new Error("This tab is not saved yet.");
      if (layout.readOnly !== null) throw new Error(layout.readOnly);
      await layout.edit((doc) => (doc === null ? null : renameDocTab(doc, tab.id, name)));
    },
    [layouts, tabs],
  );
  const pinTab = useCallback(
    async (key: string, pinned: boolean): Promise<void> => {
      const tab = tabs.find((each) => each.key === key);
      const layout = tab === undefined ? undefined : layouts.find((each) => each.machine === tab.machine);
      if (tab === undefined || tab.transient || layout === undefined) throw new Error("This tab is not saved yet.");
      if (layout.readOnly !== null) throw new Error(layout.readOnly);
      if (layout.editPins === undefined) throw new Error("The pins of this machine cannot take changes now.");
      const pins = layout.pins ?? new Set<string>();
      const live = tabs.filter((each) => each.machine === tab.machine && !each.transient).map((each) => each.id);
      await Promise.all([
        layout.editPins(pinEdit(live, tab.id, pinned)),
        layout.edit((doc) => (doc === null ? null : placePinned(doc, tab.id, pins))),
      ]);
    },
    [layouts, tabs],
  );
  const closeSetOf = useCallback(
    (key: string, which: "right" | "others"): readonly string[] => {
      const tab = tabs.find((each) => each.key === key);
      const doc = tab === undefined ? null : (layouts.find((each) => each.machine === tab.machine)?.doc ?? null);
      if (tab === undefined || doc === null) return [];
      const pins = new Set(tabs.filter((each) => each.machine === tab.machine && each.pinned).map((each) => each.id));
      const closing = new Set(closeSet(doc, tab.id, which, pins));
      return tabs.filter((each) => each.spaceKey === tab.spaceKey && closing.has(each.id)).map((each) => each.key);
    },
    [layouts, tabs],
  );

  return {
    tabs,
    shown,
    selectSpace,
    active,
    focused,
    zoomed,
    selectTab,
    focusPane,
    openTerminal,
    placeTerminal,
    split,
    dropPane,
    closeTab,
    fresh,
    claimed,
    seen: view.seen,
    remember,
    ...moves,
    moveTab,
    renameTab,
    pinTab,
    closeSetOf,
    lastMove,
    restored: machinesListed && layouts.every((layout) => layout.loaded || layout.readOnly !== LAYOUT_LOADING),
  };
}
