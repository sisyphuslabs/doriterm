import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { guideStore } from "../pair/first-run-guide.ts";
import {
  PHONE_LIST,
  type PhoneRoute,
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
}

/**
 * The history entry this page loaded on. Every entry above it was pushed by this page, so Back can pop it; at or below
 * it a pop would leave the app (a cold open on `?t=` or `?s=`), so Back goes to the screen above by address instead. Kept
 * for the document, not the component: a workspace mounted again (a reconnect) has not loaded the page again.
 */
let landed: number | null = null;

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
    select: (state) => state.location.search as { readonly s?: unknown; readonly t?: unknown },
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
  const show = useCallback(
    (address: string) => {
      // Opening a terminal is what the first-run guide is waiting for (#668); this stays even when no entry is pushed.
      guideStore.opened(address);
      // A desktop keeps no history entries of its own: its New tab and its notices are not navigations, and pushing one
      // made Back step through no-op entries and a landing run close the screen behind it.
      if (!narrow) return;
      // Switching inside an open terminal replaces its entry, so one Back still leaves the terminal for where it came from.
      go({ space: listed.space, terminal: tabKey(address, ids) }, listed.terminal !== null);
    },
    [go, ids, listed.space, listed.terminal, narrow],
  );
  const showSpace = useCallback((spaceKey: string) => go({ space: spaceKey, terminal: null }, false), [go]);
  const back = useCallback(() => {
    if (landed !== null && index > landed) router.history.back();
    else go(phoneParent(listed), true);
  }, [go, index, listed, router]);
  const backFromSpace = useCallback(() => {
    if (listed.terminal === null) back();
    else go(PHONE_LIST, true);
  }, [back, go, listed.terminal]);
  const dropSpace = useCallback(() => {
    if (path === "/" && listed.space !== null) go({ space: null, terminal: listed.terminal }, true);
  }, [go, listed.space, listed.terminal, path]);
  return { open, space, show, showSpace, back, backFromSpace, dropSpace, pushed: forward.current };
}
