import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { night, resolveTheme } from "../../packages/ui/src/theme/index.ts";

const nightTheme = resolveTheme(night);

/**
 * The browser's title/status bar colour at first launch. A fresh install opens in the dark Night theme, so the meta the
 * page starts with is Night's too; applyAppearance() re-points it to whatever theme is in view once the app runs (#1403).
 */
const themeColor = {
  name: "doriface-theme-color",
  transformIndexHtml: () => [
    { tag: "meta", attrs: { name: "theme-color", content: nightTheme.roles.chrome }, injectTo: "head" as const },
  ],
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
      manifest: {
        // `id` pins the installed app to the origin root, so a later start_url change does not register as a second app.
        id: "/",
        name: "Doriterm",
        short_name: "Doriterm",
        lang: "en",
        description: "Your terminals and agents, from any device.",
        display: "standalone",
        start_url: "/",
        scope: "/",
        // The dark default (DEFAULT_APPEARANCE in src/appearance/stored.ts), matching the Night meta a first launch
        // starts with; a person who picks Light keeps it once the app loads (#1403).
        background_color: nightTheme.roles.background,
        theme_color: nightTheme.roles.chrome,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          // A maskable icon at each of the two sizes a launcher asks for, so neither is upscaled into the safe zone.
          { src: "icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
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
