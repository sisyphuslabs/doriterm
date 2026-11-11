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
 * size against its containing block: the viewport for a fixed one; for an absolute one, the padding box of the nearest
 * box from its own element up that is positioned, transformed (transform or translate, rotate, scale), filtered, given
 * perspective, content-visibility or paint/layout containment (a static button's hit layer is placed by the tab item
 * around it, #1530, #2366), else the page. A containing block this cannot read (an inline box's) throws, as does a
 * pseudo-element with an app-region that is neither absolute nor fixed, instead of being skipped.
 */
export function appRegionAt({ x, y }: { readonly x: number; readonly y: number }): "drag" | "no-drag" | "none" {
  let at: "drag" | "no-drag" | "none" = "none";
  // An absolute box's containing block (CSS 2 10.1, CSS Transforms): the nearest box, from the pseudo-element's own
  // element up, that is positioned or that a transform, filter, perspective or paint/layout containment makes one;
  // null for the page. An inline box there places it by its fragments, which this does not read.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends only this function's source
  const containingBlock = (from: Element): Element | null | "unreadable" => {
    for (
      let node: Element | null = from;
      node !== null && node !== document.documentElement;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      const contain = style.contain;
      const establishes =
        style.position !== "static" ||
        style.transform !== "none" ||
        style.translate !== "none" ||
        style.rotate !== "none" ||
        style.scale !== "none" ||
        style.filter !== "none" ||
        style.backdropFilter !== "none" ||
        /auto|hidden/.test(style.contentVisibility) ||
        style.perspective !== "none" ||
        /paint|layout|strict|content/.test(contain) ||
        /transform|translate|rotate|scale|perspective|filter/.test(style.willChange);
      if (!establishes) continue;
      return style.display === "inline" ? "unreadable" : node;
    }
    return null;
  };
  const apply = (mode: string, box: { left: number; top: number; right: number; bottom: number }): void => {
    if (mode !== "drag" && mode !== "no-drag") return;
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) at = mode;
  };
  const pseudo = (element: Element, which: "::before" | "::after"): void => {
    const style = getComputedStyle(element, which);
    const mode = style.getPropertyValue("-webkit-app-region");
    if (style.content === "none" || style.content === "normal" || (mode !== "drag" && mode !== "no-drag")) return;
    if (style.visibility !== "visible" || style.display === "none") return;
    let origin = { left: 0, top: 0 };
    if (style.position === "absolute") {
      const block = containingBlock(element);
      if (block === "unreadable")
        throw new Error(`${element.tagName}${which} has app-region ${mode} and no readable box`);
      if (block === null) {
        origin = { left: -window.scrollX, top: -window.scrollY };
      } else {
        const box = block.getBoundingClientRect();
        // A scrolled containing block moves what it places by its scroll offset.
        origin = {
          left: box.left + block.clientLeft - block.scrollLeft,
          top: box.top + block.clientTop - block.scrollTop,
        };
      }
    } else if (style.position !== "fixed") {
      throw new Error(`${element.tagName}${which} has app-region ${mode} and no readable box`);
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
