// Chromium does not hand a transform animated on an svg element to its compositor on a display whose scale is not 1,
// which is every Retina display: the page then recalculates style and rebuilds its layer tree on the main thread for
// every frame of every spinner on screen, for as long as an agent works (#2607). A browser test cannot see it: an
// emulated scale leaves the engine's own at 1. The app can be started at a scale of 2 anywhere, and Chromium's trace
// records each animation it could not composite, with the reason.
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

interface AnimationEvent {
  readonly name: string;
  readonly id?: string;
  readonly id2?: { readonly local?: string; readonly global?: string };
  readonly args?: { readonly data?: { readonly nodeName?: string; readonly compositeFailed?: number } };
}

const idOf = (event: AnimationEvent): string | undefined => event.id2?.local ?? event.id2?.global ?? event.id;

test("a working agent's spinner is turned by the compositor at a display scale of 2", async () => {
  const session = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...session.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const hc = (args: readonly string[]): string => execFileSync(env["HC_BIN"] ?? "hc", args, { env, encoding: "utf8" });
  // Launched inside the try: a launch that fails still stops the scratch session and removes the profile.
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      ...launchOptions([`--user-data-dir=${profile}`, "--force-device-scale-factor=2"]),
      env,
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Use this computer" }).click();
    await expect(page.getByRole("region", { name: "Agents", exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);

    const cdp = await page.context().newCDPSession(page);
    const events: AnimationEvent[] = [];
    cdp.on("Tracing.dataCollected", ({ value }) => {
      events.push(...(value as unknown as AnimationEvent[]));
    });
    // Recorded from before the agent starts, so its spinner's animation is created inside the trace.
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { includedCategories: ["devtools.timeline"] },
    });
    hc(["run", "--bg", "--no-parent", "--name", "spin-turn", "--", "sh", "-c", WORKING]);
    const spinner = page.getByRole("region", { name: "Agents", exact: true }).locator('[data-slot="spinner"]').first();
    await expect(spinner).toBeVisible({ timeout: 30_000 });
    const onSharedClock = () =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => (animation as CSSAnimation).animationName === "spin" && animation.startTime === 0)
            .length,
      );
    await expect.poll(onSharedClock).toBeGreaterThanOrEqual(1);
    // A capture waits for a composited frame, hidden window or not: by then the compositor has had its say.
    await page.screenshot();
    const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.end");
    await complete;

    const animations = events.filter((event) => event.name === "Animation");
    const spinning = new Set(
      animations.filter((event) => event.args?.data?.nodeName?.includes("animate-spin-status")).map(idOf),
    );
    expect(spinning.size).toBeGreaterThanOrEqual(1);
    const refused = animations.filter(
      (event) => spinning.has(idOf(event)) && (event.args?.data?.compositeFailed ?? 0) !== 0,
    );
    expect(refused.map((event) => event.args?.data?.compositeFailed)).toEqual([]);
  } finally {
    try {
      await app?.close();
    } finally {
      await session.dispose();
      rmSync(profile, { recursive: true, force: true });
    }
  }
});

/** A program that reports itself working over OSC 7501 and then waits. */
const WORKING = "printf '\\033]7501;state=working\\033\\\\'; exec sleep 600";
