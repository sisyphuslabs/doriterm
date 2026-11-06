import { expect, test } from "./fixtures.ts";

interface ManifestIcon {
  readonly src: string;
  readonly type: string;
  readonly sizes: string;
  readonly purpose?: string;
}

function isIcon(value: unknown): value is ManifestIcon {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "src") === "string" &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "sizes") === "string"
  );
}

/** What iOS reads to open the home-screen app standalone. */
const APPLE_META = [
  ["apple-mobile-web-app-capable", "yes"],
  ["apple-mobile-web-app-status-bar-style", "default"],
  ["apple-mobile-web-app-title", "Doriterm"],
] as const;

test("the app is installable, serves its icons and registers its service worker", async ({ page, request }, info) => {
  const manifest: unknown = await (await request.get("/manifest.webmanifest")).json();
  // `id` pins the installed app to the origin root: a later start_url change must not register a second app.
  expect(manifest).toMatchObject({
    id: "/",
    lang: "en",
    name: "Doriterm",
    short_name: "Doriterm",
    display: "standalone",
    start_url: "/",
    scope: "/",
  });
  const icons: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "icons") : null;
  expect(Array.isArray(icons)).toBe(true);
  const listed = Array.isArray(icons) ? icons.filter(isIcon) : [];
  const served = await Promise.all(
    listed.map(async (icon) => (await request.get(`/${icon.src}`)).headers()["content-type"]),
  );
  expect(served).toEqual(listed.map((icon) => icon.type));

  // A launcher that masks the icon asks for the 192 and the 512; both are here so neither is upscaled into the safe zone.
  const maskable = listed.filter((icon) => icon.purpose === "maskable").map((icon) => icon.sizes);
  expect(maskable.toSorted()).toEqual(["192x192", "512x512"]);

  await page.goto("/settings");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");

  const apple = await page.evaluate(() =>
    [...document.head.querySelectorAll("meta[name^='apple-mobile-web-app']")].map((meta) => [
      meta.getAttribute("name"),
      meta.getAttribute("content"),
    ]),
  );
  expect(apple).toEqual(expect.arrayContaining(APPLE_META.map(([name, content]) => [name, content])));
  expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);

  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  await info.attach("installability.json", {
    body: JSON.stringify(installabilityErrors, null, 2),
    contentType: "application/json",
  });
  expect(installabilityErrors).toEqual([]);
});
