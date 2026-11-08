import { describe, expect, test } from "bun:test";
import { pruneIconFonts, splitIconFonts } from "./icon-font-cache.ts";

const BASE = "https://doriterm.test/sw.js";

describe("splitIconFonts", () => {
  test("takes the icon font out of the precache list and names its path", () => {
    const { precache, iconFonts } = splitIconFonts(
      [
        { url: "index.html", revision: "1" },
        "assets/index-a1.js",
        { url: "assets/symbols-nerd-font-mono-Dk1.woff2", revision: null },
        { url: "assets/jetbrains-mono-latin-b2.woff2", revision: null },
      ],
      BASE,
    );
    expect(precache).toEqual([
      { url: "index.html", revision: "1" },
      "assets/index-a1.js",
      { url: "assets/jetbrains-mono-latin-b2.woff2", revision: null },
    ]);
    expect([...iconFonts]).toEqual(["/assets/symbols-nerd-font-mono-Dk1.woff2"]);
  });
});

describe("pruneIconFonts", () => {
  test("deletes the copies the build does not use and keeps its own", async () => {
    const kept = new Map(
      ["/assets/symbols-nerd-font-mono-old1.woff2", "/assets/symbols-nerd-font-mono-Dk1.woff2"].map((path) => [
        path,
        new Request(new URL(path, BASE)),
      ]),
    );
    const cache = {
      keys: async () => [...kept.values()],
      delete: async (request: RequestInfo | URL) =>
        kept.delete(new URL(request instanceof Request ? request.url : String(request)).pathname),
    };
    const deleted = await pruneIconFonts(cache, new Set(["/assets/symbols-nerd-font-mono-Dk1.woff2"]));
    expect(deleted).toBe(1);
    expect([...kept.keys()]).toEqual(["/assets/symbols-nerd-font-mono-Dk1.woff2"]);
  });
});
