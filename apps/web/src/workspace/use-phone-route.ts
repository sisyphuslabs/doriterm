import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { guideStore } from "../pair/first-run-guide.ts";
import { hasLaunchNotice, hasPendingNotice, useLaunchTapPending } from "../push/notice-open.ts";
import { keepsPlace, loadPhonePlace, placeStart, rekeyPlace, rekeyPlaceHref, savePhonePlace } from "./phone-place.ts";
import {
  PHONE_LIST,
  type PhoneRoute,
  type PhoneSection,
  phoneHref,
  phoneOpenKey,
  phoneParent,
  phoneRoute,
  rememberOpenKey,
} from "./phone-route.ts";
import { type MachineIds, tabAddress, tabKey } from "./tab-keys.ts";

/** The phone's navigation: what it shows, from the route, and the moves between its screens. */
export interface PhoneNavigation {
  /** The open terminal's address; null on a desktop, or with none open. */
  readonly open: string | null;
  /** The key of the space whose screen the phone shows (under an open terminal too); null on the list or a desktop. */
  readonly space: string | null;
  /** The section the phone shows, its bottom tab bar's current tab. */
  readonly section: PhoneSection;
  /** Shows a section's list: the bottom tab bar's tabs. */
  readonly showSection: (section: PhoneSection) => void;
  /** Opens a terminal full screen: from a list or a space screen it is one entry more, a switch replaces the entry. */
  readonly show: (address: string) => void;
  /** Opens a space's screen, one entry over the list. */
  readonly showSpace: (key: string) => void;
  /** One level up: the screen under this one, never out of the app. */
  readonly back: () => void;
  /** The space screen's Back: to the list, also when the address still names a terminal that has gone. */
  readonly backFromSpace: () => void;
  /** Forgets a space that is no longer listed (closed here or elsewhere), in place: the list shows, no entry is added. */
  readonly dropSpace: () => void;
  /**
   * Whether the space screen in view was reached by a push: only then does it slide in. One shown again under an open
   * terminal's entry (the terminal went away) was not pushed, whichever way the last move went.
   */
  readonly pushed: boolean;
  /**
   * Leaves the open terminal, whose tab has closed: to `next` in its place (a switch, replacing its entry), else up to
   * the screen it was opened from (#1478).
   */
  readonly leave: (next: string | null) => void;
  /** Whether the switch sheet is open over the open terminal (`&sheet=switch`). */
  readonly sheet: boolean;
  /** Opens the switch sheet (one entry over its terminal) or closes it (Back off that entry). */
  readonly showSheet: (open: boolean) => void;
}

/**
 * The history entry this page loaded on. Every entry above it was pushed by this page, so Back can pop it; at or below
 * it a pop would leave the app (a cold open on `?t=` or `?s=`), so Back goes to the screen above by address instead. Kept
 * for the document, not the component: a workspace mounted again (a reconnect) has not loaded the page again.
 */
let landed: number | null = null;

/** The history entry the Spaces tab pushed over the agents list: the only one the Agents tab may pop back from. */
let spacesOverAgents: number | null = null;

/**
 * Whether this page has decided where a cold start on the bare list goes (the remembered place, or nowhere), and the
 * address it sent the phone to: the place is kept again only once the route has reached it.
 */
let placeDecided = false;
let restoring: string | null = null;
let saved: string | null = null;

/** The router's place of an entry in this tab's history (@tanstack/history), counted from the page's first entry. */
const ENTRY_INDEX = "__TSR_index";

/**
 * The phone place of the entry under this one, kept in the entry's own history state when this page pushed it there. A
 * reload forgets which entries the page pushed (`landed` starts again), but not this: Back can still pop down to the
 * screen it goes to instead of replacing this entry with a second copy of it (#1153).
 */
declare module "@tanstack/react-router" {
  interface HistoryState {
    readonly phoneUnder?: string;
    /** The core this page went through when it made the entry: its `?s=`/`?t=` are keyed for it (#2588). */
    readonly phoneCore?: string;
  }
}

/**
 * Each phone screen is a history entry (`?s=`, `?t=`), so Android's Back walks up one screen at a time instead of leaving
 * the app, and a reload reopens what was open without pushing a second entry. A desktop keeps no entries of its own.
 */
export function usePhoneRoute(narrow: boolean, ids: MachineIds): PhoneNavigation {
  const navigate = useNavigate();
  const router = useRouter();
  const search = useRouterState({
    select: (state) =>
      state.location.search as {
        readonly v?: unknown;
        readonly s?: unknown;
        readonly t?: unknown;
        readonly sheet?: unknown;
      },
  });
  const path = useRouterState({ select: (state) => state.location.pathname });
  const index = useRouterState({ select: (state) => state.location.state[ENTRY_INDEX] });
  const under = useRouterState({ select: (state) => state.location.state.phoneUnder ?? null });
  landed ??= index;
  // The direction of the last move between entries: a push raises the index, a pop or a Back lowers it.
  const lastIndex = useRef(index);
  const forward = useRef(false);
  if (index !== lastIndex.current) {
    forward.current = index > lastIndex.current;
    lastIndex.current = index;
  }
  // The core this load first went through: entries without a phoneCore (the landing entry, made before any push) are
  // keyed for it. Set once, never moved (#2589 review).
  const loadCore = useRef("");
  if (loadCore.current === "" && ids.core !== undefined) loadCore.current = ids.core;
  const entryCore = useRouterState({ select: (state) => state.location.state.phoneCore ?? null });
  const entryKeyedFor = entryCore ?? loadCore.current;
  // The address's space and terminal are read keyed for the core the page goes through now, so nothing downstream ever
  // sees an entry's keys for another core; the effect below writes the re-keyed address in place (#2588).
  const addressed = phoneRoute(search);
  const route = rekeyPlace(addressed, entryKeyedFor, ids.core ?? "");
  const listed = path === "/" ? route : PHONE_LIST;
  // Settings and pairing are routes with no terminal or space in them: they say nothing about either, so the last ones
  // the list had stay open under them (the workspace is kept mounted there, #607).
  const lastKey = useRef<string | null>(null);
  const lastSpace = useRef<string | null>(null);
  lastKey.current = rememberOpenKey(path, route.terminal, lastKey.current);
  lastSpace.current = rememberOpenKey(path, route.space, lastSpace.current);
  const key = phoneOpenKey(path, route.terminal, lastKey.current);
  const space = narrow ? phoneOpenKey(path, route.space, lastSpace.current) : null;
  const open = key === null || !narrow ? null : (tabAddress(key, ids) ?? null);
  const go = useCallback(
    (next: PhoneRoute, replace: boolean, underNow?: string | null) => {
      // A push records the place it leaves, the entry now under it; a replace keeps the record of the entry it replaces,
      // because what sits under it has not changed (a re-key hands it in re-keyed, `underNow`).
      const below = replace ? (underNow === undefined ? under : underNow) : path === "/" ? phoneHref(listed) : null;
      const made = ids.core ?? "";
      void navigate({
        href: phoneHref(next),
        replace,
        state: () => ({
          ...(below === null ? {} : { phoneUnder: below }),
          ...(made === "" ? {} : { phoneCore: made }),
        }),
      });
    },
    [ids.core, listed, navigate, path, under],
  );
  // An entry made through another core (Back after a route move, or the route moved while it was open) is rewritten in
  // place with the re-keyed place and the entry under it, so Back still pops (#2588, #2589 review).
  useEffect(() => {
    if (path !== "/" || (route.space === addressed.space && route.terminal === addressed.terminal)) return;
    const now = ids.core ?? "";
    go(route, true, under === null ? null : rekeyPlaceHref(under, entryKeyedFor, now));
  }, [addressed, entryKeyedFor, go, ids.core, path, route, under]);
  // The open space and terminal in the address are keyed for the core the page went through when the entry was made
  // (its own history state, or the route this load started on): an entry made through another core - this one after a
  // mid-session route move, or an earlier one Back lands on - is re-keyed in place, replaced, no new entry (#2588).

  const back = useCallback(() => {
    // Popping is right when this page pushed the entry in this load, and also when the entry under this one is the very
    // screen Back goes to - which a reload forgets in `landed` but not in the entry's own state (#1153).
    const parent = phoneParent(listed);
    if ((landed !== null && index > landed) || under === phoneHref(parent)) router.history.back();
    else go(parent, true);
  }, [go, index, listed, router, under]);
  // The sheet's entry is left by a Back, once: what it switches to is shown when that Back has landed on its terminal.
  const sheetClosing = useRef(false);
  const afterSheet = useRef<string | null>(null);
  // Leaving a closed tab with nowhere to switch to, from the sheet: the sheet's Back lands on that tab's own screen first,
  // so the step up to the screen it came from waits for that landing (#1478 review).
  const upAfterSheet = useRef(false);
  /** Set while a Back off a space pops down to the space's own landing entry, which the list then replaces (#2200). */
  const listAfterPop = useRef(false);
  /** Set from a Back off a space that pops until the pop lands, so a second tap does not pop again (#2229). */
  const popping = useRef(false);
  const sheetOn = narrow && path === "/" && listed.sheet;
  const showSheet = useCallback(
    (opening: boolean) => {
      if (opening) {
        if (!listed.sheet && listed.terminal !== null) go({ ...listed, sheet: true }, false);
        return;
      }
      if (!listed.sheet || sheetClosing.current) return;
      sheetClosing.current = true;
      back();
    },
    [back, go, listed],
  );
  const show = useCallback(
    (address: string) => {
      // Opening a terminal is what the first-run guide is waiting for (#668); this stays even when no entry is pushed.
      guideStore.opened(address, ids);
      // A desktop keeps no history entries of its own: its New tab and its notices are not navigations, and pushing one
      // made Back step through no-op entries and a landing run close the screen behind it.
      if (!narrow) return;
      // From the sheet: its entry goes first, so the switch replaces the terminal's own entry, not the sheet's.
      if (sheetOn) {
        afterSheet.current = address;
        showSheet(false);
        return;
      }
      // Switching inside an open terminal replaces its entry, so one Back still leaves the terminal for where it came from.
      go({ ...listed, terminal: tabKey(address, ids) }, listed.terminal !== null);
    },
    [go, ids, listed, narrow, sheetOn, showSheet],
  );
  useEffect(() => {
    if (sheetOn) return;
    sheetClosing.current = false;
    const next = afterSheet.current;
    afterSheet.current = null;
    // A switch wins over a step up asked for in the same close (an End settling before the sheet's Back lands): the
    // up intent goes with it, so a later Back off the sheet only closes the sheet (#1478 review).
    const up = upAfterSheet.current;
    upAfterSheet.current = false;
    if (next !== null) show(next);
    else if (up) back();
  }, [back, sheetOn, show]);
  const showSpace = useCallback(
    (spaceKey: string) => go({ section: listed.section, space: spaceKey, terminal: null, sheet: false }, false),
    [go, listed.section],
  );
  const showSection = useCallback(
    (section: PhoneSection) => {
      const atRoot = listed.space === null && listed.terminal === null;
      if (section === listed.section && atRoot) return;
      // Spaces is one entry over the agents, so the Agents tab goes back down to it rather than stacking another - but
      // only from the very entry the Spaces tab pushed: one that replaced a space gone from under it (dropSpace) has no
      // Agents list below it, so that one is replaced by the agents in place.
      // After a reload `spacesOverAgents` is gone, but the entry's own record of what is under it is not (#1695).
      const overAgents = spacesOverAgents === index || under === phoneHref(PHONE_LIST);
      if (section === "agents" && listed.section === "spaces" && atRoot && overAgents) {
        spacesOverAgents = null;
        router.history.back();
        return;
      }
      if (section === "agents") return go(PHONE_LIST, true);
      // From the agents, Spaces is entered (one entry); within Spaces, its tab goes back to its own list in place.
      if (listed.section !== "spaces") spacesOverAgents = index + 1;
      return go({ section: "spaces", space: null, terminal: null, sheet: false }, listed.section === "spaces");
    },
    [go, index, listed, router, under],
  );
  const backFromSpace = useCallback(() => {
    if (listed.terminal === null) return back();
    // One Back at a time: a second tap before the first pop lands would pop again, below the list (#2229).
    if (popping.current) return;
    // Shown under a terminal that went away: the terminal's entry (and its sheet's) sit over the space's, which this page
    // pushed over the list when it is above the landing entry, so Back pops all of them; else the list replaces it.
    const over = listed.sheet ? 3 : 2;
    const spaceHref = phoneHref({ ...listed, terminal: null, sheet: false });
    if (landed !== null && index - over >= landed) {
      popping.current = true;
      router.history.go(-over);
    } else if ((landed !== null && index - over + 1 >= landed) || (!listed.sheet && under === spaceHref)) {
      // The space's own entry is under this one but not known to be pushed over the list (a cold open, or a reload on the
      // space or on this terminal): pop down to it, then Back from there, which pops to the list when the space's entry
      // records it, else replaces the space with it - so no Back meets the space, or a copy of the list, again (#2200).
      popping.current = true;
      listAfterPop.current = true;
      router.history.go(1 - over);
    } else go({ ...listed, space: null, terminal: null, sheet: false }, true);
  }, [back, go, index, listed, router, under]);
  // The pop has landed once the history moves; `listed` is rebuilt on every render, so it cannot mark that (#2235 review).
  useEffect(() => {
    popping.current = false;
  }, [index]);
  useEffect(() => {
    if (!listAfterPop.current || listed.terminal !== null) return;
    listAfterPop.current = false;
    back();
  }, [back, listed]);
  // A cold start on the bare list (the home screen's icon) picks up where the phone was; an address that names a place, a
  // tapped notice, or a page that has already moved, wins. From then on every place the list route reaches is kept.
  const place = phoneHref({ ...listed, sheet: false });
  const launchPending = useLaunchTapPending();
  useEffect(() => {
    if (!narrow || path !== "/") return;
    if (!placeDecided) {
      const remembered = loadPhonePlace(ids.core ?? "");
      const start = placeStart({
        atBareList: place === "/",
        landedHere: landed === index,
        noticePending: hasPendingNotice() || hasLaunchNotice(),
        launchPending,
        remembered: phoneHref(remembered),
      });
      // Nothing is decided, or kept, until an app knows whether a notice launched it.
      if (start === "wait") return;
      placeDecided = true;
      if (start === "restore") {
        restoring = phoneHref(remembered);
        go(remembered, true);
        return;
      }
    }
    if (!keepsPlace(place, restoring !== null)) return;
    restoring = null;
    if (place === saved) return;
    saved = place;
    savePhonePlace(listed, ids.core ?? "");
  }, [go, index, launchPending, listed, narrow, path, place]);
  const dropSpace = useCallback(() => {
    if (path === "/" && listed.space !== null) go({ ...listed, space: null }, true);
  }, [go, listed, path]);
  const leave = useCallback(
    (next: string | null) => {
      if (!narrow) return;
      if (next !== null) show(next);
      else if (sheetOn) {
        upAfterSheet.current = true;
        showSheet(false);
      } else back();
    },
    [back, narrow, sheetOn, show, showSheet],
  );
  const section = narrow ? listed.section : "agents";
  return {
    open,
    space,
    section,
    show,
    showSpace,
    showSection,
    back,
    backFromSpace,
    dropSpace,
    pushed: forward.current && listed.terminal === null,
    leave,
    sheet: sheetOn,
    showSheet,
  };
}
