import { expect, test } from "bun:test";
import { parsePointer, resolveChannel } from "./channel.ts";
import { FakeBucket, point } from "./testing/fakes.ts";

test("a pointer is read only when every field has its type and the rollout is a whole percentage", () => {
  const good = { version: "0.1.17", previous: "0.1.16", rollout: 25, minimum: "0.1.10", publishedAt: "t" };
  expect(parsePointer(JSON.stringify(good))).toEqual(good);
  for (const bad of [
    "not json",
    "null",
    JSON.stringify({ ...good, version: "v0.1.17" }),
    JSON.stringify({ ...good, rollout: 101 }),
    JSON.stringify({ ...good, rollout: 12.5 }),
    JSON.stringify({ ...good, rollout: "100" }),
    JSON.stringify({ ...good, previous: 16 }),
    JSON.stringify({ ...good, minimum: "latest" }),
    JSON.stringify({ version: "0.1.17", rollout: 100 }),
  ]) {
    expect([bad, parsePointer(bad)]).toEqual([bad, null]);
  }
});

test("a yanked version is never offered: its pointer falls back to previous, fully rolled out", async () => {
  const bucket = new FakeBucket();
  point(bucket, "stable", { version: "0.1.17", previous: "0.1.16", rollout: 10, minimum: "0.1.17" });
  expect(await resolveChannel(bucket, "stable")).toEqual({
    channel: "stable",
    version: "0.1.17",
    rollout: 10,
    minimum: "0.1.17",
  });
  bucket.put("releases/v0.1.17/.yanked", "{}");
  // The floor above the version it falls back to is dropped: 0.1.16 cannot require 0.1.17.
  expect(await resolveChannel(bucket, "stable")).toEqual({ channel: "stable", version: "0.1.16", rollout: 100 });
  bucket.put("releases/v0.1.16/.yanked", "{}");
  expect(await resolveChannel(bucket, "stable")).toBeNull();
});

test("beta offers the newer of the beta and stable pointers, and stable alone before any beta", async () => {
  const bucket = new FakeBucket();
  expect(await resolveChannel(bucket, "beta")).toBeNull();
  point(bucket, "stable", { version: "0.1.17" });
  expect((await resolveChannel(bucket, "beta"))?.channel).toBe("stable");
  point(bucket, "beta", { version: "0.1.18-beta.1", rollout: 50 });
  expect(await resolveChannel(bucket, "beta")).toEqual({ channel: "beta", version: "0.1.18-beta.1", rollout: 50 });
  expect((await resolveChannel(bucket, "stable"))?.version).toBe("0.1.17");
  point(bucket, "stable", { version: "0.1.18" });
  expect((await resolveChannel(bucket, "beta"))?.version).toBe("0.1.18");
});
