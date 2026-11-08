import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { guideStore } from "../pair/first-run-guide.ts";
import { hasPendingNotice } from "../push/notice-open.ts";
import { loadPhonePlace, savePhonePlace } from "./phone-place.ts";
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
  /** Whether the last move between entries went forward (a push): only then does a pushed screen slide in. */
  readonly pushed: boolean;
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
  landed ??= index;
  // The direction of the last move between entries: a push raises the index, a pop or a Back lowers it.
  const lastIndex = useRef(index);
  const forward = useRef(false);
  if (index !== lastIndex.current) {
    forward.current = index > lastIndex.current;
    lastIndex.current = index;
  }
  const route = phoneRoute(search);
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
    (next: PhoneRoute, replace: boolean) => void navigate({ href: phoneHref(next), replace }),
    [navigate],
  );
  const back = useCallback(() => {
    if (landed !== null && index > landed) router.history.back();
    else go(phoneParent(listed), true);
  }, [go, index, listed, router]);
  // The sheet's entry is left by a Back, once: what it switches to is shown when that Back has landed on its terminal.
  const sheetClosing = useRef(false);
  const afterSheet = useRef<string | null>(null);
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
      guideStore.opened(address);
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
    if (next !== null) show(next);
  }, [sheetOn, show]);
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
      if (section === "agents" && listed.section === "spaces" && atRoot && spacesOverAgents === index) {
        spacesOverAgents = null;
        router.history.back();
        return;
      }
      if (section === "agents") return go(PHONE_LIST, true);
      // From the agents, Spaces is entered (one entry); within Spaces, its tab goes back to its own list in place.
      if (listed.section !== "spaces") spacesOverAgents = index + 1;
      return go({ section: "spaces", space: null, terminal: null, sheet: false }, listed.section === "spaces");
    },
    [go, index, listed, router],
  );
  const backFromSpace = useCallback(() => {
    if (listed.terminal === null) back();
    else go({ ...listed, space: null, terminal: null, sheet: false }, true);
  }, [back, go, listed]);
  // A cold start on the bare list (the home screen's icon) picks up where the phone was; an address that names a place, a
  // tapped notice, or a page that has already moved, wins. From then on every place the list route reaches is kept.
  const place = phoneHref({ ...listed, sheet: false });
  useEffect(() => {
    if (!narrow || path !== "/") return;
    if (!placeDecided) {
      placeDecided = true;
      const remembered = loadPhonePlace();
      if (place === "/" && landed === index && !hasPendingNotice() && phoneHref(remembered) !== "/") {
        restoring = phoneHref(remembered);
        go(remembered, true);
        return;
      }
    }
    if (restoring !== null) {
      if (place !== restoring) return;
      restoring = null;
    }
    if (place === saved) return;
    saved = place;
    savePhonePlace(listed);
  }, [go, index, listed, narrow, path, place]);
  const dropSpace = useCallback(() => {
    if (path === "/" && listed.space !== null) go({ ...listed, space: null }, true);
  }, [go, listed, path]);
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
    pushed: forward.current,
    sheet: sheetOn,
    showSheet,
  };
}
