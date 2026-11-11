// #2258: a new terminal asked for as a new space while the first live terminal is shown alone keeps that tab beside the
// new one in the same write (keepTransient's `with-new`). When the terminal is adopted (here by this screen's own
// adoption, whose write lands first) while that write waits, the new tab still goes to the new space it was asked for,
// not after the adopting tab (use-layout.ts `follows`, #2247).
import { LAYOUT_DOC } from "@doriface/protocol/layout";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

/** Each space of the saved layout as the terminals its tabs' panes show, in document order. */
const savedSpaces = (): string[][] => {
  const doc = getCoreDoc(LAYOUT_DOC);
  const spaces = typeof doc === "object" && doc !== null && "spaces" in doc ? doc.spaces : [];
  return (Array.isArray(spaces) ? spaces : []).map((space) =>
    [...JSON.stringify(space).matchAll(/"terminal":"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
};

test("a new space asked for while the tab kept beside it is adopted meanwhile stays a new space", async ({ page }) => {
  const kept = getCoreDoc(LAYOUT_DOC);
  // Only a screen whose layout holds no tab shows a live terminal alone, as on a first start.
  setCoreDoc(LAYOUT_DOC, null);
  const started: unknown = JSON.parse(hcOn("host", ["run", "--bg", "--name", "kept-alone", "--", "sh"]));
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error("no address");
  const alone = String(started.address);
  let fresh = "";
  try {
    const link = await routeHcSocket(page);
    // Every layout write of this screen is held from the start: its own adoption of the terminal shown alone (a "Home"
    // space) would otherwise land first, and no tab would be left shown alone for the new space to keep.
    const release = link.hold("doc.set");
    await page.goto("/");
    await expect(page.locator('[data-tab-id="transient"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(`[data-terminal="${alone}"]`).first()).toBeVisible({ timeout: 20_000 });

    // This screen's own adoption of the tab shown alone has been sent and is held, so it lands before the new space's.
    const sentWrites = (): number => link.sent().filter((frame) => frame.includes('"method":"doc.set"')).length;
    await expect.poll(sentWrites, { timeout: 15_000 }).toBeGreaterThan(0);
    // The new space's write, which keeps the tab shown alone beside the new one, is held on its way too.
    const answers = (): number => link.received().filter((frame) => frame.includes('"result":{"address"')).length;
    const before = answers();
    // This core's own machine, not the added one: the new terminal must be of the shown-alone tab's machine.
    await page.getByRole("button", { name: new RegExp(`^New space on (?!${MACHINE_NAME}$)`) }).click();
    // The new terminal's run has answered, so its tab's write is queued behind this screen's held adoption write.
    await expect.poll(answers, { timeout: 15_000 }).toBeGreaterThan(before);
    expect(getCoreDoc(LAYOUT_DOC)).toBeNull();
    // The adoption lands first (a "Home" space); the queued new-space write then finds its kept tab adopted.
    release();

    await expect.poll(() => savedSpaces().flat().length, { timeout: 15_000 }).toBe(2);
    fresh =
      savedSpaces()
        .flat()
        .find((terminal) => terminal !== alone) ?? "";
    // The adopting tab keeps its space to itself; the new terminal is the first tab of a new space.
    expect(savedSpaces()).toEqual([[alone], [fresh]]);
  } finally {
    for (const address of [alone, fresh]) {
      if (address === "") continue;
      hcOn("host", ["kill", address]);
      hcOn("host", ["rm", address]);
    }
    setCoreDoc(LAYOUT_DOC, kept);
  }
});
