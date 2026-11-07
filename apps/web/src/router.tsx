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
import { SettingsRoute } from "./routes/settings-route.tsx";
import { SettingsDialog, SettingsInDialog, useSettingsSheet } from "./settings/settings-dialog.tsx";
import { WorkspaceRoute } from "./routes/workspace-route.tsx";

/**
 * The workspace stays mounted under Settings, inert, so leaving Settings shows its terminals as they were: no pane
 * attaches again and replays its history (seconds over the relay), the scroll stays where it was, and the keyboard goes
 * back to the focused pane's terminal, as it did when the workspace mounted again. On a wide, tall enough screen Settings
 * is a dialog over the workspace, which stays in view and keeps drawing; on a phone, or a screen too short for the dialog,
 * it is a full-screen sheet and the workspace under it is hidden.
 */
/**
 * Where Settings shows: the sheet or the dialog. Settings renders into one frame of its own, which moves here, so a
 * resize across the breakpoint moves it instead of mounting it again: the open section, a key recording and anything
 * else under way survive the switch (#859). Focus inside it is put back after the move.
 */
function SettingsSlot({
  frame,
  refocus,
}: {
  readonly frame: HTMLElement;
  readonly refocus: RefObject<HTMLElement | null>;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    slot.current?.append(frame);
    const held = refocus.current;
    refocus.current = null;
    if (held !== null && frame.contains(held) && document.activeElement !== held) held.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      refocus.current = active instanceof HTMLElement && frame.contains(active) ? active : null;
    };
  }, [frame, refocus]);
  return <div ref={slot} className="contents" />;
}

function Root() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const settings = path === "/settings";
  const asSheet = useSettingsSheet();
  const sheet = settings && asSheet;
  const [frame] = useState(() => Object.assign(document.createElement("div"), { className: "h-full" }));
  const refocus = useRef<HTMLElement | null>(null);
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
        // cover the menu (the workspace behind is invisible, so this layer only has to paint over nothing).
        <div className="fixed inset-0 bg-background">
          <SettingsSlot frame={frame} refocus={refocus} />
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
        className={sheet ? "invisible contents [&_*]:invisible!" : "contents"}
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
          <SettingsSlot frame={frame} refocus={refocus} />
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
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
