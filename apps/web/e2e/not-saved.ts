import type { Page } from "@playwright/test";

/**
 * How many "The layout was not saved" notices the page has shown from now on, closed ones included: a notice closes
 * itself after five seconds, which a loaded runner can outlast between the refusal and a spec's last check (#1328).
 */
export async function notSavedNotices(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    let shown = 0;
    Reflect.set(window, "__notSavedNotices", () => shown);
    new MutationObserver((records) => {
      for (const node of records.flatMap((record) => [...record.addedNodes]))
        if (node instanceof Element)
          shown += [node, ...node.querySelectorAll("*")].filter(
            (element) => element.childElementCount === 0 && element.textContent === "The layout was not saved",
          ).length;
    }).observe(document.body, { subtree: true, childList: true });
  });
  return () =>
    page.evaluate(() => {
      const read: unknown = Reflect.get(window, "__notSavedNotices");
      return typeof read === "function" ? Number(read()) : Number.NaN;
    });
}
