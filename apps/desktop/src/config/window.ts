import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";
import { VERSION_ARG, type DesktopPlatform } from "../shared/bridge.ts";

/** The web app's top row (sidebar and Settings headers, h-11) that the window buttons share. */
export const TITLEBAR_ROW_HEIGHT = 44;

/** The three window buttons macOS draws: 14 pt buttons 20 pt apart in a 16 pt tall frame. */
const WINDOW_BUTTONS_SIZE = { width: 54, height: 16 } as const;

/** herdr-app's 12 pt side inset, centred on the top row so the buttons line up with its titles and controls. */
export const TRAFFIC_LIGHT_POSITION = {
  x: 12,
  y: (TITLEBAR_ROW_HEIGHT - WINDOW_BUTTONS_SIZE.height) / 2,
} as const;

export const TRAFFIC_LIGHTS = { ...TRAFFIC_LIGHT_POSITION, ...WINDOW_BUTTONS_SIZE } as const;

/**
 * herdr-app's gap between the last window button and the first item beside it (its app icon, then the name): 12 pt,
 * measured from its macOS titlebar (#392).
 */
export const TITLEBAR_TITLE_GAP = 12;

/** Where content beside the window buttons may start, one title gap past the last button. */
export const TITLEBAR_INSET_START = TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS.width + TITLEBAR_TITLE_GAP;

/**
 * Controls inside a titlebar row that must keep taking clicks instead of moving the window; a whole tab pill
 * (`data-tab-id`) is one, so pressing anywhere on it drags the tab, not the window.
 */
export const TITLEBAR_CONTROLS =
  'a, button, input, select, textarea, [role="tab"], [role="button"], [tabindex], [data-tab-id]';

/**
 * Under the hidden-inset titlebar the band above the traffic lights still has to move the window, whether or not the
 * page has a titlebar row. Rows the web app marks data-titlebar are the window's titlebar: they move the window and
 * take the system's double-click action, while the controls in them stay clickable.
 */
export const MAC_TITLEBAR_CSS = [
  `html::before { content: ""; position: fixed; inset: 0 0 auto 0; height: ${TRAFFIC_LIGHT_POSITION.y}px; -webkit-app-region: drag; z-index: 2147483647; }`,
  "[data-titlebar] { -webkit-app-region: drag; }",
  `[data-titlebar] :is(${TITLEBAR_CONTROLS}) { -webkit-app-region: no-drag; }`,
].join(" ");

/** The sidebar's icon rail on macOS: wide enough to clear the window buttons (herdr-app's 76 px). */
export const MAC_RAIL_WIDTH = 76;

/**
 * The web app reads --titlebar-inset-start to keep what it draws in the top-left corner out from under the window
 * buttons. Full screen hides the buttons, so the shell removes this sheet there.
 */
export const MAC_INSET_CSS = `:root { --titlebar-inset-start: ${TITLEBAR_INSET_START}px; --sidebar-rail-width: ${MAC_RAIL_WIDTH}px; }`;

export function secureWebPreferences(preload: string, version: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    additionalArguments: [`${VERSION_ARG}${version}`],
  };
}

/** Each system appearance's page background (themes.css --background), painted before the page so nothing flashes. */
export const WINDOW_BACKGROUND = { light: "#f7f6f3", dark: "#121210" } as const;

/** The sidebar beside a terminal; narrower would drop below the 768 px phone breakpoint inside a desktop window. */
export const MIN_WINDOW_SIZE = { width: 800, height: 500 } as const;

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const;

export interface WindowPlacement {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowLook {
  /** The page background the window paints before the page does. */
  readonly background: string;
  readonly placement: WindowPlacement;
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export const isHexColour = (value: unknown): value is string => typeof value === "string" && HEX_COLOUR.test(value);

/** The background the in-app theme last reported (saved as `{ background }`), else the system appearance's. */
export function launchBackground(saved: unknown, dark: boolean): string {
  const background: unknown =
    typeof saved === "object" && saved !== null ? Reflect.get(saved, "background") : undefined;
  if (isHexColour(background)) return background;
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

/**
 * How long the window waits for its first frame before showing anyway, painted with its background colour (#88). A
 * GPU process still bringing up the system GL driver (a VM, a remote desktop, software-only Mesa, a cold disk) can hold
 * that frame for seconds or forever; a fast first frame still shows the window first, so nothing changes there.
 */
export const FIRST_SHOW_DEADLINE_MS = 1_000;

export function windowOptions(
  platform: DesktopPlatform,
  webPreferences: WebPreferences,
  look: WindowLook,
): BrowserWindowConstructorOptions {
  const base: BrowserWindowConstructorOptions = {
    title: "Doriterm",
    ...look.placement,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    backgroundColor: look.background,
    webPreferences,
  };
  if (platform !== "darwin") return base;
  return { ...base, titleBarStyle: "hiddenInset", trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } };
}
