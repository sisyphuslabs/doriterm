/**
 * `?edgeprobe=1`: a line at the bottom of the screen that says what iOS finds at the page's top edge (#2867), for a look
 * on a real iPhone. WebKit hit-tests the point 4 px under the top centre, first ignoring pointer-events, and takes the
 * first fixed or sticky box from there; it brings its blur back while the page is pulled past its top. The line names
 * that box, the document's scroll, the visual viewport and the top inset, and follows every scroll and resize.
 */
export function startEdgeProbe(search: string): void {
  if (new URLSearchParams(search).get("edgeprobe") !== "1") return;
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
      `inset top ${inset.getBoundingClientRect().height} standalone ${matchMedia("(display-mode: standalone)").matches}`,
    ].join("\n");
  };
  for (const target of [window, window.visualViewport]) {
    target?.addEventListener("scroll", update, { passive: true });
    target?.addEventListener("resize", update);
  }
  document.addEventListener("touchend", update, { passive: true });
  update();
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
