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

/**
 * #1166: a page still open on an earlier build can ask the new worker for that build's font. The worker answers it from
 * the network but stores only the font its own build names, so the earlier copy is not kept until the next release.
 */
test("the worker stores the icon font its build names, and not an earlier build's that a page asks for", async ({
  page,
  request,
}) => {
  const html = await (await request.get("/")).text();
  const sheets = [...html.matchAll(/href="(\/assets\/[^"]+\.css)"/g)].map((match) => match[1] ?? "");
  const css = (await Promise.all(sheets.map(async (sheet) => (await request.get(sheet)).text()))).join("\n");
  const current = ICON_FONT.exec(css)?.[0];
  if (current === undefined) throw new Error("the build's stylesheets name no icon font");
  const earlier = "/assets/symbols-nerd-font-mono-0ld0ld0l.woff2";
  // The test must be able to fail: the server answers the earlier name, so only the worker's own check keeps it out.
  expect((await request.get(earlier)).ok()).toBe(true);

  await page.goto("/settings");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });

  const kept = await page.evaluate(
    async ({ name, urls }) => {
      const cache = await caches.open(name);
      await Promise.all((await cache.keys()).map((entry) => cache.delete(entry)));
      // Both go through the worker's icon font route, as a page's @font-face load does.
      for (const url of urls) await (await fetch(url, { cache: "no-store" })).arrayBuffer();
      return (await cache.keys()).map((entry) => new URL(entry.url).pathname);
    },
    { name: FONT_CACHE, urls: [current, earlier] },
  );
  expect(kept).toEqual([current]);
});
