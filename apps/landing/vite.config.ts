import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Two pages: the landing itself (plain HTML, CSS and one module) and mockup/index.html (served at /mockup/), which renders the app's own
 * components with fixture data. The landing embeds the mockup in iframes in its hero, so React and Tailwind stay inside
 * the frames and never style the landing page.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        mockup: resolve(import.meta.dirname, "mockup", "index.html"),
      },
    },
  },
});
