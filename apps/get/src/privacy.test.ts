import { expect, test } from "bun:test";
import { recordDownload } from "./datapoint.ts";
import { route } from "./index.ts";
import { harness, macFeed, mirror, point } from "./testing/fakes.ts";

test("the datapoint writer emits exactly the nine fields of #1969 and nothing else", () => {
  const h = harness();
  recordDownload(h.env.DOWNLOADS, {
    kind: "desktop",
    route: "dl",
    source: "r2",
    channel: "stable",
    version: "0.1.17",
    asset: "Doriterm-0.1.17-arm64.dmg",
    platform: "mac-arm64",
    country: "KR",
    qa: false,
  });
  expect(h.points).toEqual([
    {
      blobs: ["desktop", "dl", "r2", "stable", "0.1.17", "Doriterm-0.1.17-arm64.dmg", "mac-arm64", "KR", ""],
      doubles: [1],
      indexes: ["desktop"],
    },
  ]);
  // The writer's only parameters are the dataset and the event: a request cannot be handed to it.
  expect(recordDownload.length).toBe(2);
});

test("serving a counted request reads only the Range, If-Range and User-Agent headers, never an install id or cookie", async () => {
  const h = harness();
  mirror(h.bucket, "0.1.17", { "latest-mac.yml": macFeed("0.1.17"), "Doriterm-0.1.17-arm64.dmg": "dmg" });
  point(h.bucket, "stable", { version: "0.1.17" });
  const read = new Set<string>();
  const paths = [
    "/desktop/stable/latest-mac.yml",
    "/desktop/stable/0.1.17/Doriterm-0.1.17-arm64.dmg",
    "/dl/mac-arm64.dmg",
  ];
  const requests = paths.map((path) => {
    const headers = new Headers({
      "User-Agent": "electron-builder",
      "x-user-staging-id": "1b4b5c3e-uuid",
      Cookie: "session=secret",
      "CF-Connecting-IP": "203.0.113.9",
    });
    const spy = new Proxy(headers, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") read.add(`${String(property)}:${args[0].toLowerCase()}`);
          if (property !== "get" && property !== "has") read.add(`${String(property)}:*`);
          return Reflect.apply(value, target, args);
        };
      },
    });
    const request = new Request(`https://get.doriterm.com${path}`);
    Object.defineProperty(request, "headers", { value: spy });
    return request;
  });
  await Promise.all(requests.map((request) => route(request, h.ctx)));
  expect([...read].toSorted()).toEqual(["get:if-range", "get:range", "get:user-agent"]);
  const stored = JSON.stringify(h.points);
  for (const secret of ["1b4b5c3e", "secret", "203.0.113.9", "electron-builder"]) expect(stored).not.toContain(secret);
  expect(h.points.length).toBe(2);
});
