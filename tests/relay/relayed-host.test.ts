import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayedHost } from "./support/relayed-host.ts";

describe("startRelayedHost", () => {
  test("an uplink that never connects rejects within its bound and tears everything down", async () => {
    // A scratch parent of this test's own: other suites running at the same time make scratch dirs in the shared tmp
    // dir, which a scan of it would count as this start's leftovers (#234).
    const root = mkdtempSync(join(tmpdir(), "relayed-host-test-"));
    try {
      const startedAt = performance.now();
      const failure = await startRelayedHost("relay-unreachable", {
        hostRelayUrl: "http://127.0.0.1:9",
        uplinkTimeoutMs: 2_000,
        scratchRoot: root,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain("the host's relay uplink did not happen within 2000 ms");
      expect(performance.now() - startedAt).toBeLessThan(60_000);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
