import type { Page } from "@playwright/test";

/**
 * Records the layout shifts that moved a node in the sidebar, from the first paint; add it with `page.addInitScript`
 * and read it with `sidebarShift(page)`. A source whose box is where it was is not a move: a count whose digit changes
 * in place (a loose terminal adopted into its tab as the workspace loads, #2129) is reported with a score of about 6e-7
 * and the same box before and after (#2321, #2808). The whole function runs in the page, so it uses nothing from here.
 */
export function observeSidebarShifts(): void {
  const shifts: PerformanceEntry[] = [];
  new PerformanceObserver((list) => shifts.push(...list.getEntries())).observe({
    type: "layout-shift",
    buffered: true,
  });
  Reflect.set(window, "__sidebarShift", () =>
    shifts
      .filter((shift) => Reflect.get(shift, "hadRecentInput") !== true)
      .filter((shift) => {
        const aside = document.querySelector("aside");
        const sources: unknown = Reflect.get(shift, "sources");
        return (
          Array.isArray(sources) &&
          sources.some((source: unknown) => {
            if (typeof source !== "object" || source === null) return false;
            const node: unknown = Reflect.get(source, "node");
            const before: unknown = Reflect.get(source, "previousRect");
            const after: unknown = Reflect.get(source, "currentRect");
            const moved =
              !(before instanceof DOMRectReadOnly) ||
              !(after instanceof DOMRectReadOnly) ||
              before.x !== after.x ||
              before.y !== after.y ||
              before.width !== after.width ||
              before.height !== after.height;
            return moved && node instanceof Node && aside?.contains(node) === true;
          })
        );
      })
      .reduce((sum, shift) => sum + Number(Reflect.get(shift, "value")), 0),
  );
}

/** The summed score of the sidebar moves recorded so far, read two frames on so the last update's shift is in. */
export const sidebarShift = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const measure: unknown = Reflect.get(window, "__sidebarShift");
    return typeof measure === "function" ? Number(measure()) : Number.NaN;
  });
