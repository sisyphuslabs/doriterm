import { useSyncExternalStore } from "react";
import { guardedLocalStorage } from "../storage/guarded.ts";

const KEY = "doriface.debug.edge-probe";
let running: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Whether the readout is on, as Settings shows it: a Home Screen app has no address bar for `?edgeprobe=1`. */
export function useEdgeProbe(): boolean {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => running !== null,
  );
}

interface ProbeDeps {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly show: () => () => void;
}

const browserDeps = (): ProbeDeps => ({ storage: guardedLocalStorage(), show: showEdgeProbe });

/**
 * Turns the readout on or off now. `remember` stores the choice for the next launch; it is stored as on only after the
 * readout actually showed, so a readout that throws can never be left on to break every later launch.
 */
export function setEdgeProbe(on: boolean, deps: ProbeDeps = browserDeps(), remember = true): void {
  if (on && running === null) running = deps.show();
  if (!on && running !== null) {
    running();
    running = null;
  }
  if (remember) deps.storage.setItem(KEY, on ? "1" : "0");
  for (const listener of listeners) listener();
}

/** Starts the readout at launch when `?edgeprobe=1` asks for it or Settings left it on. */
export function startEdgeProbe(
  search: string,
  deps: ProbeDeps = browserDeps(),
  report: (error: unknown) => void = (error) => console.error("edge readout failed to start", error),
): void {
  const asked = new URLSearchParams(search).get("edgeprobe") === "1";
  const stored = deps.storage.getItem(KEY) === "1";
  if (!asked && !stored) return;
  try {
    // ?edgeprobe=1 shows it for this visit only; only the Settings switch remembers it.
    setEdgeProbe(true, deps, false);
  } catch (error) {
    // The app must start even if the readout cannot: the stored switch is turned off so the next launch is clean.
    if (stored) deps.storage.setItem(KEY, "0");
    report(error);
  }
}

/**
 * `?edgeprobe=1` or Settings > This device: a line at the bottom of the screen that says what iOS finds at the page's top edge (#2867), for a look
 * on a real iPhone. WebKit hit-tests the point 4 px under the top centre, first ignoring pointer-events, and takes the
 * first fixed or sticky box from there; it brings its blur back while the page is pulled past its top. The line names
 * that box, the document's scroll, the visual viewport and the top inset, and follows every scroll and resize.
 */
function showEdgeProbe(): () => void {
  const line = document.createElement("pre");
  line.setAttribute("aria-hidden", "true");
  line.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:2147483646;margin:0;padding:4px 6px;font:11px/1.3 ui-monospace,monospace;white-space:pre-wrap;background:rgb(0 0 0/.8);color:#fff;pointer-events:none";
  const inset = document.createElement("div");
  inset.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden";
  document.body.append(line, inset);
  const update = (): void => {
    const viewport = window.visualViewport;
    line.textContent = [
      `edge: ${describe(edgeAt(window.innerWidth / 2, 4))}`,
      `scrollY ${Math.round(window.scrollY)} vv top ${Math.round(viewport?.offsetTop ?? 0)} page ${Math.round(viewport?.pageTop ?? 0)} h ${Math.round(viewport?.height ?? 0)}/${window.innerHeight}`,
      `inset top ${inset.getBoundingClientRect().height} standalone ${matchMedia("(display-mode: standalone)").matches} bar ${document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute("content") ?? "none"}`,
      `header: ${describeHeader(document.querySelector("[data-phone-top]"))}`,
    ].join("\n");
  };
  for (const target of [window, window.visualViewport]) {
    target?.addEventListener("scroll", update, { passive: true });
    target?.addEventListener("resize", update);
  }
  document.addEventListener("touchend", update, { passive: true });
  const teardown = (): void => {
    for (const target of [window, window.visualViewport]) {
      target?.removeEventListener("scroll", update);
      target?.removeEventListener("resize", update);
    }
    document.removeEventListener("touchend", update);
    line.remove();
    inset.remove();
  };
  return firstUpdateOrTeardown(update, teardown);
}

/**
 * Runs the readout's first update; if it throws (iOS before 16.4 has no adoptedStyleSheets for the hit test), the nodes
 * and listeners already added are removed before the error goes on, so no strip or listener is left behind and a
 * repeated tap does not stack another set.
 */
export function firstUpdateOrTeardown(update: () => void, teardown: () => void): () => void {
  try {
    update();
  } catch (error) {
    teardown();
    throw error;
  }
  return teardown;
}

function describeHeader(header: Element | null): string {
  if (header === null) return "none on this screen";
  const style = getComputedStyle(header);
  const rect = header.getBoundingClientRect();
  return `${style.position} top ${Math.round(rect.top)} h ${Math.round(rect.height)} z ${style.zIndex} ${style.backgroundColor}`;
}

/** The first fixed or sticky box at a point, as WebKit's first pass finds it: pointer-events: none boxes count. */
function edgeAt(x: number, y: number): Element | null {
  // elementFromPoint honours pointer-events, WebKit's first pass does not: every box takes the hit while it looks.
  const everyBox = new CSSStyleSheet();
  everyBox.replaceSync("* { pointer-events: auto !important; }");
  const sheets = document.adoptedStyleSheets;
  document.adoptedStyleSheets = [...sheets, everyBox];
  const hit = document.elementFromPoint(x, y);
  document.adoptedStyleSheets = sheets;
  for (let at = hit; at !== null; at = at.parentElement) {
    const { position } = getComputedStyle(at);
    if (position === "fixed" || position === "sticky") return at;
  }
  return null;
}

function describe(box: Element | null): string {
  if (box === null) return "none (iOS blurs)";
  const style = getComputedStyle(box);
  const rect = box.getBoundingClientRect();
  const name = box.hasAttribute("data-top-edge")
    ? "top-edge strip"
    : box.hasAttribute("data-titlebar")
      ? "header"
      : box.tagName.toLowerCase();
  return `${name} ${style.position} ${Math.round(rect.width)}x${Math.round(rect.height)} ${style.backgroundColor}`;
}
