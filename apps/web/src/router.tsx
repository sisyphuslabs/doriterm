import { createRootRoute, createRoute, createRouter, Outlet, useRouterState } from "@tanstack/react-router";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connectionStore } from "./connection/store.ts";
import { CrashScreen } from "./crash/crash-screen.tsx";
import { TerminalsOnScreen } from "./device/keep-awake.ts";
import { ActionsPaused } from "./keys/dispatcher.ts";
import { keyboardIsIdle, mayTakeFocus } from "./terminal/may-take-focus.ts";
import { capturePairingLink } from "./pair/link-capture.ts";
import { PairRoute } from "./routes/pair-route.tsx";
import { JoinLanding } from "./pair/join-landing.tsx";
import { SettingsRoute } from "./routes/settings-route.tsx";
import { SettingsDialog, SettingsInDialog, useSettingsSheet } from "./settings/settings-dialog.tsx";
import { WorkspaceRoute } from "./routes/workspace-route.tsx";
import { useNarrow } from "./workspace/use-narrow.ts";

/** Where the settings body was scrolled to when its frame was taken out of the page, and which element scrolled. */
interface KeptScroll {
  readonly viewport: HTMLElement;
  readonly top: number;
}

/**
 * Where Settings shows: the sheet or the dialog. Settings renders into one frame of its own, which moves here, so a
 * resize across the breakpoint moves it instead of mounting it again: the open section, a key recording and anything
 * else under way survive the switch (#859). Focus inside it is put back after the move, and so is the settings body's
 * scroll offset (#1161).
 */
function SettingsSlot({
  frame,
  refocus,
  scroll,
  documentScroll = false,
}: {
  readonly frame: HTMLElement;
  readonly refocus: RefObject<HTMLElement | null>;
  readonly scroll: RefObject<KeptScroll | null>;
  /** The phone's sheet, which the document scrolls rather than its body (#2533). */
  readonly documentScroll?: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    slot.current?.append(frame);
    const kept = scroll.current;
    scroll.current = null;
    // Taking the frame out of the page drops the offset of whatever scrolls in it, so the reader's place is put back
    // before the frame is painted in its other home (#1161). A viewport from an earlier Settings is gone with it, and
    // a fresh one starts at the top as it always has. On a phone the document is what scrolls, and it opens at its top
    // rather than where the list under it was.
    const top = kept !== null && frame.contains(kept.viewport) ? kept.top : 0;
    if (documentScroll) window.scrollTo({ top, behavior: "instant" });
    else if (kept !== null && frame.contains(kept.viewport)) kept.viewport.scrollTop = kept.top;
    const held = refocus.current;
    refocus.current = null;
    if (held !== null && frame.contains(held) && document.activeElement !== held) held.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      refocus.current = active instanceof HTMLElement && frame.contains(active) ? active : null;
      // Read before the frame leaves the page: once it is out, its viewport has forgotten where it was (#1161).
      const viewport = frame.querySelector<HTMLElement>('[data-slot="settings-body"]');
      const leftAt = documentScroll ? Math.round(window.scrollY) : (viewport?.scrollTop ?? 0);
      scroll.current = viewport === null ? null : { viewport, top: leftAt };
    };
  }, [frame, refocus, scroll, documentScroll]);
  return <div ref={slot} className="contents" />;
}

/**
 * The workspace stays mounted under Settings, inert, so leaving Settings shows its terminals as they were: no pane
 * attaches again and replays its history (seconds over the relay), the scroll stays where it was, and the keyboard goes
 * back to the focused pane's terminal, as it did when the workspace mounted again. On a wide, tall enough screen Settings
 * is a dialog over the workspace, which stays in view and keeps drawing; on a phone, or a screen too short for the dialog,
 * it is a full-screen sheet and the workspace under it is hidden.
 */
function Root() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const settings = path === "/settings";
  const asSheet = useSettingsSheet();
  const sheet = settings && asSheet;
  // On a phone the sheet scrolls the document, as the phone's lists do, so a tap on iOS's status bar takes it to the top
  // (#2533): it sits in the page's flow, and the workspace under it is held to the screen, out of the flow.
  const narrow = useNarrow();
  const phoneSheet = sheet && narrow;
  const [frame] = useState(() => Object.assign(document.createElement("div"), { className: "h-full" }));
  const refocus = useRef<HTMLElement | null>(null);
  const scroll = useRef<KeptScroll | null>(null);
  useEffect(() => {
    if (settings) return;
    // Back at the workspace while a reconnect waits out its back-off: try now, not up to 10 s on (#403).
    connectionStore.retryNow();
    const input = document.querySelector<HTMLElement>('[data-focused="true"] [data-terminal] textarea');
    const terminal = input?.closest<HTMLElement>("[data-terminal]");
    if (input && terminal && mayTakeFocus(terminal) && keyboardIsIdle(terminal)) input.focus({ preventScroll: true });
  }, [settings]);
  if (path !== "/" && !settings) return <Outlet />;
  return (
    <>
      {sheet ? (
        // No z-index: a menu or dialog Settings portals to the body paints in DOM order, and a layer above it would
        // cover the menu (the workspace behind is invisible, so this layer only has to paint over nothing). It is a modal
        // dialog named Settings, as the wide screen's is: the workspace under it is hidden from assistive tech, so the
        // sheet is the page's one landmark (#1378).
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          data-settings-sheet
          className={phoneSheet ? "relative min-h-dvh bg-background" : "fixed inset-0 bg-background"}
        >
          <SettingsSlot frame={frame} refocus={refocus} scroll={scroll} documentScroll={phoneSheet} />
        </div>
      ) : null}
      {/* The view on screen is #root's first child: the desktop window waits for `#root > *` to paint, and the
          workspace kept under the phone's sheet is invisible, so it must not come first there. Under the sheet every
          element is hidden, not only the wrapper: visibility is inherited, so a part that reveals itself (a touch
          screen's row actions) would otherwise be drawn over Settings, which paints after it in no layer of its own
          (#879). */}
      {/* Under the dialog the workspace stays in view but out of reach: inert, and hidden from assistive tech, so only
          the dialog is read (aria-modal). */}
      <div
        data-workspace
        className={
          phoneSheet
            ? "invisible fixed inset-0 overflow-hidden [&_*]:invisible!"
            : sheet
              ? "invisible contents [&_*]:invisible!"
              : "contents"
        }
        inert={settings}
        aria-hidden={settings || undefined}
      >
        <ActionsPaused.Provider value={settings}>
          <TerminalsOnScreen.Provider value={!sheet}>
            <WorkspaceRoute />
          </TerminalsOnScreen.Provider>
        </ActionsPaused.Provider>
      </div>
      {/* After the workspace, so the dialog paints over its layers at the same modal level; what Settings portals to
          the body comes after #root and paints over the dialog. */}
      {settings && !asSheet ? (
        <SettingsDialog>
          <SettingsSlot frame={frame} refocus={refocus} scroll={scroll} />
        </SettingsDialog>
      ) : null}
      {settings
        ? createPortal(
            <SettingsInDialog value={!asSheet}>
              <Outlet />
            </SettingsInDialog>,
            frame,
          )
        : null}
    </>
  );
}

const root = createRootRoute({ component: Root });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
  createRoute({ getParentRoute: () => root, path: "/pair", component: PairRoute }),
  createRoute({ getParentRoute: () => root, path: "/join", component: JoinLanding }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsRoute }),
];

// The router reads the URL once, here, and main.tsx renders and dials out only after this module has run: a pairing
// link leaves the address bar and the history first. A link opened later on the same page arrives as a hashchange.
capturePairingLink();
addEventListener("hashchange", () => capturePairingLink());

// A screen that throws while it renders shows the crash screen with Try again, instead of the router's bare fallback.
export const router = createRouter({
  routeTree: root.addChildren(routes),
  defaultErrorComponent: ({ error, reset }) => <CrashScreen error={error} onRetry={reset} />,
  // The workspace and Settings keep their own scroll: the workspace stays mounted under Settings, and on a phone each
  // list and Settings put the page's offset back themselves (#2533). The router neither resets nor restores the window
  // between them; any other screen gets its offset back on Back and starts at the top otherwise.
  scrollRestoration: ({ location }) => location.pathname !== "/" && location.pathname !== "/settings",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
