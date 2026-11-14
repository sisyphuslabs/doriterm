/**
 * Renders the showcase and writes every mockup to docs/design:
 *   bun run --filter @doriface/ui capture [-- --only shell,pair]
 * Needs Playwright's Chromium (bunx playwright install chromium).
 */
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "vite";

const SHOWCASE = join(import.meta.dirname, "../showcase");
const DIST = join(SHOWCASE, "dist");
const OUT = join(import.meta.dirname, "../../../docs/design");

const SCREENS = [
  "shell",
  "pair",
  "palette",
  "shortcuts",
  "settings",
  "settings-appearance",
  "settings-device",
  "settings-terminal",
  "settings-keyboard",
  "mobile",
  "mobile-agents",
  "states",
  "sidebar-recompose",
  "approval",
  "voice",
  "terminal-find",
] as const;
/** Screens whose own scroll owner hides content: captured whole, plus a viewport scrolled to the end. */
const SCROLLERS: Readonly<Record<string, string>> = {
  settings: "settings-body",
  "settings-appearance": "settings-body",
  "settings-device": "settings-body",
  "settings-terminal": "settings-body",
  "settings-keyboard": "settings-body",
};
const THEMES = [
  { name: "dark", palette: "night" },
  { name: "light", palette: "day" },
] as const;
const WIDTHS = [1440, 390] as const;

function contextFor(width: (typeof WIDTHS)[number]) {
  if (width === 390) return devices["iPhone 14"];
  return { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
}

/**
 * When the scroller overflows (the slot itself, or on a phone the page that scrolls it, #2533), writes <file>-end.png (the viewport scrolled to the end, proving the bottom is reachable), then grows
 * the viewport to the scroller's full height so the main capture shows every row.
 */
async function captureScroller(page: Page, slot: string, file: string) {
  const own = page.locator(`[data-slot="${slot}"]`);
  const owns = await own.evaluate((element) => element.scrollHeight > element.clientHeight);
  const scroller = owns ? own : page.locator(":root");
  const extra = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight);
  const viewport = page.viewportSize();
  if (viewport === null || extra <= 0) return;
  await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await page.screenshot({ path: file.replace(/\.png$/, "-end.png"), animations: "disabled" });
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  await page.setViewportSize({ ...viewport, height: viewport.height + extra });
}

async function capture(
  browser: Browser,
  origin: string,
  route: string,
  file: string,
  width: (typeof WIDTHS)[number],
  palette: string,
) {
  const context = await browser.newContext({
    ...contextFor(width),
    colorScheme: palette === "day" ? "light" : "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const insets = width === 390 ? "&insets=phone" : "";
  await page.goto(`${origin}/?theme=${palette}${insets}#/${route}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForLoadState("networkidle");
  const slot = SCROLLERS[route];
  if (slot !== undefined) await captureScroller(page, slot, file);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  await context.close();
}

async function main() {
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg === -1 ? undefined : new Set((process.argv[onlyArg + 1] ?? "").split(","));
  await build({ configFile: join(SHOWCASE, "vite.config.ts"), logLevel: "warn" });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  const browser = await chromium.launch();
  try {
    await mkdir(join(OUT, "mockups"), { recursive: true });
    const jobs: { route: string; file: string; width: (typeof WIDTHS)[number]; palette: string }[] = [];
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const add = (route: string, file: string) => {
          if (only === undefined || only.has(route)) jobs.push({ route, file, width, palette: theme.palette });
        };
        add("primitives", join(OUT, `showcase-${theme.name}-${width}.png`));
        for (const screen of SCREENS) add(screen, join(OUT, "mockups", `${screen}-${theme.name}-${width}.png`));
      }
    }
    await Promise.all(
      jobs.map((job) => capture(browser, server.url.origin, job.route, job.file, job.width, job.palette)),
    );
    for (const job of jobs) console.log(job.file);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}

await main();
