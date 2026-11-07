import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { pointOnRowStart } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

interface PointMenus {
  readonly closed: number;
  readonly closedWithMenu: number;
}

/** A stand-in for React DevTools, added before the app loads: React hands every committed root to it. */
async function collectReactRoots(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const roots = new Set<unknown>();
    Reflect.set(window, "__dorifaceFiberRoots", roots);
    Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberRoot: (_renderer: number, root: unknown) => roots.add(root),
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
    });
  });
}

/**
 * Walks every React root the page committed and finds each PointMenu by its own props, which survive the production
 * build's minification. A closed one is a fiber whose `at` is null; holding a menu means it rendered anything under
 * itself.
 */
const pointMenus = (page: Page): Promise<PointMenus> =>
  page.evaluate(() => {
    interface Fiber {
      readonly child: Fiber | null;
      readonly sibling: Fiber | null;
      readonly memoizedProps: unknown;
    }
    const roots = Reflect.get(window, "__dorifaceFiberRoots") as Set<{ readonly current: Fiber }> | undefined;
    if (roots === undefined) throw new Error("the React DevTools hook never saw a root");
    let closed = 0;
    let closedWithMenu = 0;
    for (const root of roots) {
      const stack: Fiber[] = [root.current];
      while (stack.length > 0) {
        const fiber = stack.pop();
        if (fiber === undefined) break;
        const props = fiber.memoizedProps;
        const pointMenu =
          typeof props === "object" &&
          props !== null &&
          "at" in props &&
          "label" in props &&
          typeof Reflect.get(props, "onClose") === "function";
        if (pointMenu && Reflect.get(props, "at") === null) {
          closed += 1;
          if (fiber.child !== null) closedWithMenu += 1;
        }
        if (fiber.sibling !== null) stack.push(fiber.sibling);
        if (fiber.child !== null) stack.push(fiber.child);
      }
    }
    return { closed, closedWithMenu };
  });

/**
 * Records, from before the app loads, each transition attribute Base UI puts on a menu popup: `data-starting-style` on
 * the frame a menu opens from (its scale and fade-in start there) and `data-ending-style` while it closes. Either lasts
 * a frame or two, so a later look at the DOM could miss it; an observer cannot.
 */
async function recordMenuTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    Reflect.set(window, "__dorifaceMenuTransitions", seen);
    const names = ["data-starting-style", "data-ending-style"];
    const note = (element: Element): void => {
      if (!element.matches("[role=menu]")) return;
      for (const name of names) if (element.hasAttribute(name)) seen.add(name);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element) note(record.target);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          note(node);
          for (const inner of node.querySelectorAll("[role=menu]")) note(inner);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: names });
  });
}

const menuTransitions = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(Reflect.get(window, "__dorifaceMenuTransitions") as Set<string>)].toSorted());

test("a closed point menu mounts nothing, so a pane's link and selection menus cost no render while closed (#842)", async ({
  page,
}) => {
  await collectReactRoots(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await expect(terminal).toHaveAttribute("data-ready", "true");
  // Each terminal pane draws two: the menu a tapped link opens and the one a held touch's selection opens (#680).
  await expect.poll(async () => (await pointMenus(page)).closed).toBeGreaterThanOrEqual(2);
  // Closed, a Base UI menu root still runs its floating, dismiss and list-navigation hooks on each render of its pane:
  // at 50 panes streaming output that was the render bench's long-task regression since v0.1.2.
  expect((await pointMenus(page)).closedWithMenu).toBe(0);
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("a held touch's menu still animates in and out, and mounts nothing again once it has closed (#842)", async ({
    page,
  }) => {
    await collectReactRoots(page);
    await recordMenuTransitions(page);
    const terminal = await openPhoneTerminal(page);
    await page.keyboard.type("printf 'menu%s\\n' '-motion word'\r");
    await expect(terminal).toContainText("menu-motion word", { timeout: 15_000 });

    const at = await pointOnRowStart(terminal, "menu-motion word");
    const touch = await Touch.on(page);
    await touch.down(at);
    await expect.poll(() => page.locator(".term-selection-cells > div").count()).toBeGreaterThan(0);
    await touch.up(at);
    const menu = page.getByRole("menu", { name: "Selected text" });
    await expect(menu).toBeVisible();
    // A root that mounts already open skips Base UI's enter transition: the popup would appear with no scale or fade.
    await expect.poll(() => menuTransitions(page)).toContain("data-starting-style");

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect.poll(() => menuTransitions(page)).toContain("data-ending-style");
    await expect.poll(async () => (await pointMenus(page)).closedWithMenu).toBe(0);
  });
});
