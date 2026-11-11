import { describe, expect, test } from "bun:test";
import { keepsIconFont, pruneIconFonts, splitIconFonts } from "./icon-font-cache.ts";

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

  test("keeps every copy and reports that it skipped when the build names no icon font", async () => {
    const paths = ["/assets/symbols-nerd-font-mono-old1.woff2", "/assets/symbols-nerd-font-mono-Dk1.woff2"];
    const kept = new Map(paths.map((path) => [path, new Request(new URL(path, BASE))]));
    const cache = {
      keys: async () => [...kept.values()],
      delete: async (request: RequestInfo | URL) =>
        kept.delete(new URL(request instanceof Request ? request.url : String(request)).pathname),
    };
    const deleted = await pruneIconFonts(cache, new Set());
    expect(deleted).toBeNull();
    expect([...kept.keys()]).toEqual(paths);
  });
});

describe("keepsIconFont", () => {
  const iconFonts = new Set(["/assets/symbols-nerd-font-mono-Dk1.woff2"]);

  test("keeps the copy this build's precache list names", () => {
    expect(keepsIconFont(new URL("/assets/symbols-nerd-font-mono-Dk1.woff2", BASE), iconFonts)).toBe(true);
  });

  test("refuses an earlier release's copy that a page open on the old build may still ask for", () => {
    expect(keepsIconFont(new URL("/assets/symbols-nerd-font-mono-0ld0ld0l.woff2", BASE), iconFonts)).toBe(false);
  });

  test("keeps what it fetches when the build names no icon font, as pruning keeps what is there", () => {
    expect(keepsIconFont(new URL("/assets/symbols-nerd-font-mono-Dk1.woff2", BASE), new Set())).toBe(true);
  });
});
