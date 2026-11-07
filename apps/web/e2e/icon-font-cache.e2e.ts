import { expect, test } from "./fixtures.ts";

/** sw.ts's runtime cache for the Nerd Font icon face, which is left out of the precache. */
const FONT_CACHE = "doriterm-fonts-v1";
const ICON_FONT = /\/assets\/symbols-nerd-font-mono-[^/"')]*\.woff2/;

/**
 * #967: a release that changes the icon font renames it (the name carries its contents' hash), so a device kept every
 * earlier copy (1.2 MB each). A worker that activates keeps only the copy its own build draws with.
 */
test("a worker that activates drops the icon fonts its build does not use, and keeps its own", async ({
  page,
  request,
}) => {
  const html = await (await request.get("/")).text();
  const sheets = [...html.matchAll(/href="(\/assets\/[^"]+\.css)"/g)].map((match) => match[1] ?? "");
  const css = (await Promise.all(sheets.map(async (sheet) => (await request.get(sheet)).text()))).join("\n");
  const current = ICON_FONT.exec(css)?.[0];
  if (current === undefined) throw new Error("the build's stylesheets name no icon font");
  const earlier = "/assets/symbols-nerd-font-mono-0ld0ld0l.woff2";

  // An earlier release's copy and this build's, as a device that drew icons with both has them, before this build's
  // worker exists. A plain file is opened first so nothing registers a worker yet.
  await page.goto("/favicon.svg");
  await page.evaluate(
    async ({ name, urls }) => {
      const cache = await caches.open(name);
      await Promise.all(
        urls.map((url) => cache.put(url, new Response("font", { headers: { "content-type": "font/woff2" } }))),
      );
    },
    { name: FONT_CACHE, urls: [earlier, current] },
  );

  await page.goto("/settings");
  // `activated` is reached only after the activate handler's waitUntil work has settled.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker === null || worker.state === "activated") return;
    await new Promise<void>((resolve) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    });
  });

  const kept = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((entry) => new URL(entry.url).pathname);
  }, FONT_CACHE);
  expect(kept).toEqual([current]);
});
