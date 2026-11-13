/**
 * What a press at (x, y) does in the window as Electron decides it, from the page's own `app-region` styles: "drag"
 * moves the window, "no-drag" reaches the page, "none" lies outside every region (the page gets it too).
 *
 * Neither Playwright's input nor the page's own hit testing goes through this: on macOS the window takes a press inside a
 * drag region before the page sees it, so a click Playwright sends to a button under a drag region still reaches the
 * button while a person's click moves the window. This reads the decision instead:
 *
 * - Blink lists a region for every visible box whose computed app-region is drag or no-drag, by its border box, walking
 *   the layout tree in order (LocalFrameView::CollectDraggableRegions, LayoutObject::AddDraggableRegions);
 * - Electron applies the list in that order, a drag region adding its area and a no-drag one removing it, so where two
 *   overlap the later one wins (shell/browser/ui/drag_util.cc). z-index plays no part.
 *
 * Runs in the page (pass it to `page.evaluate`). The layout tree follows the DOM except for pseudo-elements, which are
 * read in their place (::before before an element's children, ::after after them). app-region is inherited, so a
 * button's hit-area pseudo-element lists its own region too. A pseudo-element's box is read from its used insets and
 * size against its containing block (#2366: a static button's absolute hit layer is placed by its positioned ancestor).
 * That is the padding box of the nearest element, itself or an ancestor with a box, that establishes one: for an
 * absolute pseudo-element one that is positioned, and for both an absolute and a fixed one one that is transformed
 * (`transform`, `translate`, `scale`, `rotate`, `perspective`), filtered (`filter`, `backdrop-filter`), contained
 * (`contain` layout or paint, a `container-type`) or will change one of those; else the initial containing block for
 * an absolute one and the viewport for a fixed one. A block scaled or rotated has no padding box this can read, and
 * any other pseudo-element with an app-region has no readable box either: both throw instead of being skipped.
 */
export function appRegionAt({ x, y }: { readonly x: number; readonly y: number }): "drag" | "no-drag" | "none" {
  let at: "drag" | "no-drag" | "none" = "none";
  const apply = (mode: string, box: { left: number; top: number; right: number; bottom: number }): void => {
    if (mode !== "drag" && mode !== "no-drag") return;
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) at = mode;
  };
  const pseudo = (element: Element, which: "::before" | "::after"): void => {
    const style = getComputedStyle(element, which);
    const mode = style.getPropertyValue("-webkit-app-region");
    if (style.content === "none" || style.content === "normal" || (mode !== "drag" && mode !== "no-drag")) return;
    if (style.visibility !== "visible" || style.display === "none") return;
    const unreadable = new Error(`${element.tagName}${which} has app-region ${mode} and no readable box`);
    if (style.position !== "absolute" && style.position !== "fixed") throw unreadable;
    let block: Element | null = element;
    while (block !== null) {
      const own = getComputedStyle(block);
      // An element with display: contents has no box at all, and transforms do not apply to an inline box.
      const hasBox = own.display !== "contents";
      const transformed =
        own.display !== "inline" &&
        (own.transform !== "none" ||
          own.translate !== "none" ||
          own.scale !== "none" ||
          own.rotate !== "none" ||
          own.perspective !== "none" ||
          own.filter !== "none" ||
          own.backdropFilter !== "none" ||
          /\b(layout|paint|strict|content)\b/.test(own.contain) ||
          /\b(size|inline-size)\b/.test(own.containerType) ||
          /\b(transform|translate|scale|rotate|perspective|filter|backdrop-filter|contain)\b/.test(own.willChange));
      if (hasBox && (transformed || (style.position === "absolute" && own.position !== "static"))) break;
      block = block.parentElement;
    }
    let origin = { left: 0, top: 0 };
    if (block === null) {
      if (style.position === "absolute") origin = { left: -window.scrollX, top: -window.scrollY };
    } else {
      // The block's padding box is read in page coordinates, which hold only while neither it nor anything above it is
      // scaled, rotated, skewed or seen through a perspective.
      for (let above: Element | null = block; above !== null; above = above.parentElement) {
        const own = getComputedStyle(above);
        const matrix = new DOMMatrixReadOnly(own.transform === "none" ? undefined : own.transform);
        const translationOnly = matrix.is2D && matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1;
        if (!translationOnly || own.scale !== "none" || own.rotate !== "none" || own.perspective !== "none") {
          throw unreadable;
        }
      }
      const box = block.getBoundingClientRect();
      origin = { left: box.left + block.clientLeft, top: box.top + block.clientTop };
    }
    const left = origin.left + Number.parseFloat(style.left);
    const top = origin.top + Number.parseFloat(style.top);
    apply(mode, {
      left,
      top,
      right: left + Number.parseFloat(style.width),
      bottom: top + Number.parseFloat(style.height),
    });
  };
  const visit = (element: Element): void => {
    const style = getComputedStyle(element);
    if (style.display === "none") return;
    // Only boxes list a region (an inline or an SVG shape inside an <svg> has none); display: contents has no box itself.
    const box =
      style.display !== "inline" &&
      style.display !== "contents" &&
      !(element instanceof SVGElement && !(element instanceof SVGSVGElement));
    if (box && style.visibility === "visible")
      apply(style.getPropertyValue("-webkit-app-region"), element.getBoundingClientRect());
    pseudo(element, "::before");
    for (const child of element.children) visit(child);
    pseudo(element, "::after");
  };
  visit(document.documentElement);
  return at;
}
