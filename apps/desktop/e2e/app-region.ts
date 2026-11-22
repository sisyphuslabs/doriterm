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
 * an absolute one and the viewport for a fixed one. The layer moves with its block's content: the block's scroll offset
 * is taken off its offsets, except the root's, which its box already moved by (#2472). A scale on the block or above it
 * scales the layer's offsets and size;
 * a block rotated, skewed or seen through a perspective has no padding box this can read, and any other pseudo-element
 * with an app-region has no readable box either: both throw instead of being skipped.
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
      // An element with display: contents has no box at all.
      const hasBox = own.display !== "contents";
      // A filter makes any element but the root a containing block; the other properties do not apply to an inline box.
      const filtered = block !== document.documentElement && (own.filter !== "none" || own.backdropFilter !== "none");
      const transformed =
        filtered ||
        (own.display !== "inline" &&
          (own.transform !== "none" ||
            own.translate !== "none" ||
            own.scale !== "none" ||
            own.rotate !== "none" ||
            own.perspective !== "none" ||
            /\b(layout|paint|strict|content)\b/.test(own.contain) ||
            /\b(size|inline-size)\b/.test(own.containerType) ||
            /\b(transform|translate|scale|rotate|perspective|filter|backdrop-filter|contain)\b/.test(own.willChange)));
      if (hasBox && (transformed || (style.position === "absolute" && own.position !== "static"))) break;
      block = block.parentElement;
    }
    let origin = { left: 0, top: 0 };
    let scale = { x: 1, y: 1 };
    if (block === null) {
      if (style.position === "absolute") origin = { left: -window.scrollX, top: -window.scrollY };
    } else {
      // The layer's offsets are in the block's own units: a scale on the block or above it (an entrance animation runs
      // the app's rows from 0.97 to 1, #2366) shrinks them by the product of those scales. A rotation, a skew or a
      // perspective has no such product, so it throws.
      let sx = 1;
      let sy = 1;
      for (let above: Element | null = block; above !== null; above = above.parentElement) {
        const own = getComputedStyle(above);
        const matrix = new DOMMatrixReadOnly(own.transform === "none" ? undefined : own.transform);
        const axisAligned = matrix.is2D && matrix.b === 0 && matrix.c === 0 && matrix.a > 0 && matrix.d > 0;
        if (!axisAligned || own.rotate !== "none" || own.perspective !== "none") throw unreadable;
        const [scaleX = 1, scaleY = scaleX] = own.scale === "none" ? [] : own.scale.split(" ").map(Number);
        if (!(scaleX > 0 && scaleY > 0)) throw unreadable;
        sx *= matrix.a * scaleX;
        sy *= matrix.d * scaleY;
      }
      // The padding box starts inside the border; clientLeft and clientTop read 0 for an inline box, so the border is read.
      // An inline that wraps over lines starts where its first line box does; a right-to-left or vertical one starts at
      // another corner, which this does not read.
      const border = getComputedStyle(block);
      const horizontalLtr = border.direction !== "rtl" && border.writingMode === "horizontal-tb";
      if (border.display === "inline" && !horizontalLtr) throw unreadable;
      const box =
        (border.display === "inline" ? block.getClientRects()[0] : undefined) ?? block.getBoundingClientRect();
      // A layer moves with its block's content, by the block's scroll offset in its own units: an absolute one, and a fixed
      // one too, since a block that holds a fixed layer (transformed, filtered, contained or will-change) scrolls it with
      // its content. The root's scroll offset is the viewport's, which the root's own box already moved by, so it is not
      // counted twice (#2472 review).
      const scrolled = block !== document.documentElement;
      origin = {
        left: box.left + (Number.parseFloat(border.borderLeftWidth) - (scrolled ? block.scrollLeft : 0)) * sx,
        top: box.top + (Number.parseFloat(border.borderTopWidth) - (scrolled ? block.scrollTop : 0)) * sy,
      };
      scale = { x: sx, y: sy };
    }
    const left = origin.left + Number.parseFloat(style.left) * scale.x;
    const top = origin.top + Number.parseFloat(style.top) * scale.y;
    apply(mode, {
      left,
      top,
      right: left + Number.parseFloat(style.width) * scale.x,
      bottom: top + Number.parseFloat(style.height) * scale.y,
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
