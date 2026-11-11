import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { VitePWA, type ManifestOptions } from "vite-plugin-pwa";
import { day, night, resolveTheme } from "../../packages/ui/src/theme/index.ts";

const dayTheme = resolveTheme(day);
const nightTheme = resolveTheme(night);

/**
 * The version this build is (#1556): DORIFACE_BUILD_VERSION when a build is given one (release.yml's desktop job sets
 * it to the version .github/scripts/release-version.ts resolved, prerelease included), else apps/desktop/package.json's,
 * which every release tag must match. The host picks its HOST_VERSION the same way (apps/host/src/host-types.ts).
 */
const buildVersion: string =
  process.env["DORIFACE_BUILD_VERSION"] ||
  (JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")) as { version: string })
    .version;

/**
 * The web app manifest. `version` is not a standard member, so browsers ignore it, but the manifest already ships with
 * every build and is never cached stale (public/_headers), so `curl <origin>/manifest.webmanifest` says which build a
 * host serves without a Worker route.
 */
const manifest: Partial<ManifestOptions> & { readonly version: string } = {
  // `id` pins the installed app to the origin root, so a later start_url change does not register as a second app.
  id: "/",
  name: "Doriterm",
  short_name: "Doriterm",
  lang: "en",
  description: "Your terminals and agents, from any device.",
  display: "standalone",
  start_url: "/",
  scope: "/",
  // One theme for both, matching the light metas a first launch starts with.
  background_color: dayTheme.roles.background,
  theme_color: dayTheme.roles.chrome,
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
    // A maskable icon at each of the two sizes a launcher asks for, so neither is upscaled into the safe zone.
    { src: "icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
  version: buildVersion,
};

/** The browser's title/status bar colour per system scheme; the app re-points both to the theme in view at start. */
const themeColor = {
  name: "doriface-theme-color",
  transformIndexHtml: () =>
    [
      { media: "(prefers-color-scheme: light)", content: dayTheme.roles.chrome },
      { media: "(prefers-color-scheme: dark)", content: nightTheme.roles.chrome },
    ].map((attrs) => ({ tag: "meta", attrs: { name: "theme-color", ...attrs }, injectTo: "head" as const })),
};

export default defineConfig({
  plugins: [
    react(),
    themeColor,
    tailwindcss(),
    VitePWA({
      // A new worker waits for Reload to update in Settings (src/sw.ts takes SKIP_WAITING from updateSW).
      registerType: "prompt",
      // Our own worker (src/sw.ts): the same precache as before, plus the push and notification-click handlers.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: ["icon.svg", "favicon.svg", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png"],
      manifest,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,woff2}"],
        // The Nerd Font icons (1.2 MB) are listed but not precached: sw.ts fetches them the first time a page draws one,
        // keeps them, and drops the copies of earlier builds (#967).
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  build: { target: "es2023" },
});
