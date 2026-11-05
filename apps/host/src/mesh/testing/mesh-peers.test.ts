import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { meshOf, peer, storeOf } from "./mesh-peers.ts";

// The in-memory mesh fixtures test gossip and views, not crash safety: a flush per write made their run time follow the
// disk's flush latency, so on a busy disk they timed out (#91). Durability itself is tested in state/files.test.ts.
describe("mesh test fixtures", () => {
  test("building a mesh and its members' stores flushes nothing to disk", () => {
    const flush = spyOn(fs, "fsyncSync");
    try {
      const members = ["a", "b", "c"].map(peer);
      const { records } = meshOf(members);
      for (const member of members) storeOf(member, records);
      expect(flush).toHaveBeenCalledTimes(0);
    } finally {
      flush.mockRestore();
    }
  });
});
