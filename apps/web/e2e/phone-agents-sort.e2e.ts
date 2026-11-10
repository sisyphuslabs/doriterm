import { devices } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** The terminals one core lists, so a spec can end them all and count from zero. */
function addressesOn(core: "host" | "machine"): string[] {
  const listed: unknown = JSON.parse(hcOn(core, ["ls", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) return [];
  return terminals.map((terminal: unknown) =>
    typeof terminal === "object" && terminal !== null ? String(Reflect.get(terminal, "address")) : "",
  );
}

test("with agents, the phone's sort control sits in the Agents header, not on a row of its own", async ({ page }) => {
  const address = startAgent("host", "sortrow", "idle");
  try {
    await page.goto("/");
    const header = page.locator("header[data-titlebar]");
    const sort = header.getByRole("button", { name: "Sort agents" });
    await expect(sort).toBeVisible({ timeout: 20_000 });
    const [sortBox, headerBox] = await Promise.all([sort.boundingBox(), header.boundingBox()]);
    if (sortBox === null || headerBox === null) throw new Error("no box");
    expect(sortBox.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(sortBox.y + sortBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    await expect(page.getByRole("button", { name: "Sort agents" })).toHaveCount(1);

    // Sort is the header control right beside Search (the palette): same row, Search first, one header gap apart (#992).
    const search = header.getByRole("button", { name: "Command palette" });
    const controls = header.locator("button, a");
    const names = await controls.evaluateAll((all) => all.map((control) => control.getAttribute("aria-label")));
    expect(names.slice(0, 2)).toEqual(["Command palette", "Sort agents"]);
    const searchBox = await search.boundingBox();
    if (searchBox === null) throw new Error("no box");
    const gap = await header.evaluate((element) => Number.parseFloat(getComputedStyle(element).columnGap));
    expect(Math.abs(sortBox.y - searchBox.y), "Sort and Search share the header's row").toBeLessThanOrEqual(0.5);
    const beside = sortBox.x - (searchBox.x + searchBox.width);
    expect(beside, "Sort follows Search").toBeGreaterThanOrEqual(0);
    expect(beside, "with one header gap and no control between them").toBeLessThanOrEqual(gap + 0.5);

    // The last header control ends inside the phone's 390 px: the trailing one is what would run past the edge (#992).
    const width = page.viewportSize()?.width ?? 0;
    expect(width).toBe(390);
    const edges = await controls.evaluateAll((all) => all.map((control) => control.getBoundingClientRect().right));
    expect(Math.max(...edges)).toBeLessThanOrEqual(width);
  } finally {
    endAgent("host", address);
  }
});

test("with two machines and no agent, the phone shows no sort control", async ({ page }) => {
  for (const core of ["host", "machine"] as const) {
    for (const address of addressesOn(core)) hcOn(core, ["kill", address]);
  }
  await expect.poll(() => [...addressesOn("host"), ...addressesOn("machine")], { timeout: 20_000 }).toEqual([]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: "No terminals yet" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Sort agents" })).toHaveCount(0);
});
