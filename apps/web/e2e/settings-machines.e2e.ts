import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { reconnect, STATE_BOUND_MS, switchTo, OFFLINE_BOUND_MS, OFFLINE_TEST_TIMEOUT_MS } from "./machine-switch.ts";

test.describe("Settings, Machines", () => {
  test("lists this machine and the added one with their state, and says when and why one went offline", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Machines" }).click();
    await expect(page.getByRole("heading", { name: "Machines", level: 2 })).toBeVisible();
    const list = page.getByRole("list", { name: "Machines" });
    // Every machine is a peer row with the same state words, the one the page goes through included (#2531).
    await expect(list.getByRole("listitem").filter({ hasText: "studio" })).toContainText("Connected", {
      timeout: 15_000,
    });
    const added = list.getByRole("listitem").filter({ hasText: MACHINE_NAME });
    await expect(added).toContainText("Connected", { timeout: STATE_BOUND_MS });
    await page.getByRole("button", { name: "Add a machine" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    await expect(dialog).toContainText("doriface-host pair");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/ssh target/)).toHaveCount(0);
    try {
      switchTo("drop");
      await expect(added).toContainText("Offline", { timeout: OFFLINE_BOUND_MS });
      await expect(added).toContainText(/Last seen (just now|\d+m ago)/);
      await expect(added).toContainText("isn't answering");
      await expect(added).not.toContainText(/cannot reach|sh -c/);
    } finally {
      reconnect();
    }
    await expect(added).toContainText("Connected", { timeout: STATE_BOUND_MS });
  });

  test("connecting a machine is part of Machines, and an older link to it lands there", async ({ page }) => {
    await page.goto("/settings#pair");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("button", { name: "Machines" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "Connect a machine" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Connect a machine", level: 2 })).toBeInViewport();
    await expect(page.getByText("Open an invite on your host")).toBeVisible();
    await expect(page.getByRole("heading", { name: "In your mesh", level: 2 })).toBeVisible();
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the list and Add a machine lead the first screen, with the explanation below them (#1007)", async ({
      page,
    }) => {
      await page.goto("/settings#machines");
      const list = page.getByRole("list", { name: "Machines" });
      await expect(list.getByRole("listitem").first()).toContainText("Connected", { timeout: 15_000 });
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("no viewport");
      // The list leads: its heading sits in the screen's top third, not under a screenful of explanation.
      const heading = await page.getByRole("heading", { name: "Machines", level: 2 }).boundingBox();
      expect(heading?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(viewport.height / 3);
      const add = page.getByRole("button", { name: "Add a machine" });
      for (const target of [list.getByRole("listitem").first(), add]) {
        // oxlint-disable-next-line no-await-in-loop -- each target is measured on the same settled screen
        const box = await target.boundingBox();
        expect(box, "drawn").not.toBeNull();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
      }
      // The explanation of a row's state comes after them: its top edge is at or below the button's bottom edge.
      const button = await add.boundingBox();
      const glossary = await page.getByText("A machine that answers reads Connected").boundingBox();
      expect(button, "button drawn").not.toBeNull();
      expect(glossary, "explanation drawn").not.toBeNull();
      expect(glossary?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual((button?.y ?? 0) + (button?.height ?? 0));
    });

    test("the join page's Connect a machine opens Machines on that group", async ({ page }) => {
      await page.goto("/settings#connect");
      await expect(page.getByRole("tab", { name: "Machines" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: "Connect a machine" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Connect a machine", level: 2 })).toBeInViewport();
    });
  });
});
