import { expect, laidOutBox, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
  permissions: ["clipboard-read", "clipboard-write"],
});

const POSITIVE_FRAMES = /^Frames\/s ([1-9]\d*)$/;
const WORKER_READY = /^(?:Frames\/s [1-9]\d*|OffscreenCanvas is not available here)$/;
const POSITIVE_UPDATES = /Updates\/s ([1-9]\d*)/;

test("the standalone /perf probe reports main-thread, worker, and scroll rates and copies JSON results", async ({
  page,
}) => {
  await page.goto("/perf");

  const controllerGroup = page.getByRole("group", { name: "Scroll controller" });
  const mainGroup = page.getByRole("group", { name: "Main thread canvas" });
  const workerGroup = page.getByRole("group", { name: "Worker canvas" });

  await expect(controllerGroup).toBeVisible();
  await expect(mainGroup).toBeVisible();
  await expect(workerGroup).toBeVisible();

  const phaseStatus = page.getByRole("status", { name: "Frame test phase" });
  await expect(phaseStatus).toHaveText("Done", { timeout: 20_000 });

  const mainRate = page.getByRole("status", { name: "Main thread rate" });
  await expect(mainRate).toHaveText(POSITIVE_FRAMES);

  const workerRate = page.getByRole("status", { name: "Worker rate" });
  await expect(workerRate).toHaveText(WORKER_READY);

  const scroller = controllerGroup.locator("[data-perf-scroller]");
  await scroller.scrollIntoViewIfNeeded();
  const box = await laidOutBox(scroller);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const controllerRate = page.getByRole("status", { name: "Scroll controller rate" });
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 80);
      const text = (await controllerRate.textContent()) ?? "";
      const match = POSITIVE_UPDATES.exec(text);
      return match === null ? 0 : Number(match[1]);
    })
    .toBeGreaterThan(0);

  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.getByRole("button", { name: "Copy results" }).click();

  let copied = "";
  await expect
    .poll(async () => {
      copied = await page.evaluate(() => navigator.clipboard.readText());
      return copied;
    })
    .not.toBe("");

  expect(copied).not.toContain("\n");
  const parsed: unknown = JSON.parse(copied);
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object on the clipboard");

  expect(Object.keys(parsed).toSorted()).toEqual([
    "at",
    "controllerUnique",
    "controllerUpdates",
    "dpr",
    "mainFps",
    "ua",
    "workerFps",
  ]);
  expect(typeof Reflect.get(parsed, "ua")).toBe("string");
  expect(typeof Reflect.get(parsed, "dpr")).toBe("number");
  expect(Reflect.get(parsed, "controllerUpdates")).toBeGreaterThan(0);
  expect(typeof Reflect.get(parsed, "controllerUnique")).toBe("number");
  expect(Reflect.get(parsed, "mainFps")).toBeGreaterThan(0);
  expect(typeof Reflect.get(parsed, "workerFps")).toBe("number");
  expect(typeof Reflect.get(parsed, "at")).toBe("string");
});
