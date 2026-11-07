import { describe, expect, test } from "bun:test";
import { CloseCode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import type { MeshLine } from "./lines.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

/** docs/transport.md: a sync session closes after 60 s without a line. */
const LINGER_MS = 60_000;
const KEEP_ALIVE_MS = 10_000;

describe("a sync session this host dialed to a member that is then revoked (section 6.2)", () => {
  test.each([
    ["open at the revoke", false],
    ["dialed after the revoke (section 5.3's last push)", true],
  ] satisfies [string, boolean][])(
    "%s ends within 60 s, however often the revoked peer keeps it busy, and closes 4401",
    async (_when, later) => {
      const [a, b, c] = [peer("a"), peer("b"), peer("c")];
      const clock = new FakeClock();
      const net = new MeshNet(clock, seededRandom(83));
      const { records } = meshOf([a, b, c]);
      const [atA, atB] = [net.add(a, records), net.add(b, records)];
      const mesh = atB.gossip.meshId;
      const line = { t: "hello", v: 2, mesh, heads: headsOfRecords(records), n: {} } satisfies MeshLine;
      // The revoked peer answers every hello it gets, so nothing but the retirement can end the session.
      const done = { t: "done", mesh } satisfies MeshLine;
      const dial = () => {
        const [ours, theirs] = memoryLinkPair(true);
        atB.gossip.attach(c.signPub, b.signPub, ours);
        return {
          ours,
          hello: () => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n${JSON.stringify(done)}\n`)),
        };
      };
      const early = later ? undefined : dial();
      atA.gossip.append({ type: "revoke", signPubs: [c.signPub], reason: "revoke" });
      await clock.until(() => !atB.names().includes("c"), 5_000, 10);
      const since = clock.now();
      const session = early ?? dial();
      let closedAt: number | undefined;
      session.ours.onClose(() => {
        closedAt = clock.now();
      });
      const keepBusy = async (left: number): Promise<void> => {
        if (left <= 0 || closedAt !== undefined) return;
        session.hello();
        await clock.advance(KEEP_ALIVE_MS);
        return keepBusy(left - KEEP_ALIVE_MS);
      };
      await keepBusy(LINGER_MS + 3 * KEEP_ALIVE_MS);
      expect((closedAt ?? Number.POSITIVE_INFINITY) - since).toBeLessThanOrEqual(LINGER_MS);
      expect(session.ours.closeCode).toBe(CloseCode.UnknownDevice);
    },
  );
});
