import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { CounterBehindError } from "../state/mesh.ts";
import { MeshCommands } from "./commands.ts";
import { DialPolicy } from "./dial-policy.ts";
import { Gossip } from "./gossip.ts";
import type { MeshLine } from "./lines.ts";
import { NOT_RUNNING } from "./live-facts.ts";
import { syncHooks } from "./sync-hooks.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshIdOfRecords, meshOf, peer, Signer, storeOf } from "./testing/mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const stateDir = mkdtempSync(join(tmpdir(), "dh-claim-floor-"));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

/**
 * b restored from a backup taken before its own ack n = 1, which a still holds, running its gossip and the operator's
 * commands on one store through the host's own `syncHooks`; `claim()` is a's hello claiming that n = 1.
 */
function restoredB(seed: number) {
  const { records } = meshOf([a, b, c]);
  const own = new Signer(b, records).ack(headsOfRecords(records));
  const clock = new FakeClock();
  const store = storeOf(b, records);
  const gossip = new Gossip({
    store,
    identity: b.machine.identity,
    meshId: meshIdOfRecords(records),
    clock,
    random: seededRandom(seed),
    policy: new DialPolicy({ clock, random: seededRandom(seed + 1), onDue: () => undefined }),
    dial: () => Promise.reject(new Error("b dials nobody here")),
    log: () => undefined,
  });
  const commands = new MeshCommands({
    store,
    stateDir,
    identity: b.machine.identity,
    closeRevoked: () => undefined,
    hooks: syncHooks(
      { gossip, runtime: undefined, changed: () => undefined, stop: () => undefined, live: () => NOT_RUNNING },
      clock,
      () => [],
    ),
    log: () => undefined,
  });
  const [ours, theirs] = memoryLinkPair(true);
  gossip.attach(a.signPub, a.signPub, ours);
  const say = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
  const meshId = meshIdOfRecords(records);
  const claim = (): void => say({ t: "hello", v: 2, mesh: meshId, heads: [hashOf(own)], n: { [b.signPub]: 1 } });
  const deliver = (): void => {
    say({ t: "records", records: [own] });
    say({ t: "done", mesh: meshId });
  };
  const ownNs = (): readonly number[] =>
    (store.read()?.records ?? []).flatMap((record: Signed) => {
      const body = parseRecord(record);
      return body?.by === b.signPub ? [body.n] : [];
    });
  const at = async (ms: number): Promise<void> => clock.advance(ms - clock.now());
  return { commands, claim, deliver, ownNs, at, records: () => store.read()?.records ?? [] };
}

describe("the operator's commands sign nothing below a peer's standing claim (section 10.1, #154)", () => {
  test("mesh rename while a claims b's counter 1 is refused, and signs as n = 2 once a's records arrive: no fork", async () => {
    const s = restoredB(31);
    s.claim();
    await s.at(1_000);
    await expect(s.commands.rename({ member: "a", name: "a2" })).rejects.toThrow(CounterBehindError);
    await expect(s.commands.rename({ member: "a", name: "a2" })).rejects.toThrow(
      "holds counter 1 of this host's key, here 0",
    );
    expect(s.ownNs()).toEqual([]);
    s.deliver();
    await s.at(2_000);
    expect(await s.commands.rename({ member: "a", name: "a2" })).toMatchObject({ written: true });
    expect(s.ownNs()).toEqual([1, 2]);
  });

  test.each([
    [
      "mesh revoke",
      (s: ReturnType<typeof restoredB>) => s.commands.revoke({ member: "c", compromised: false, yes: true }),
    ],
    ["mesh leave", (s: ReturnType<typeof restoredB>) => s.commands.leave()],
  ])("%s while the claim stands is refused and writes nothing", async (_name, run) => {
    const s = restoredB(32);
    s.claim();
    await s.at(1_000);
    const before = s.records().length;
    // A leave that signs waits 30 s on the fake clock for confirmations, so the clock runs past that before reading.
    const outcome = run(s).then(
      () => "signed",
      (error: unknown) => error,
    );
    await s.at(32_000);
    expect(await outcome).toBeInstanceOf(CounterBehindError);
    expect(s.records()).toHaveLength(before);
    expect(s.ownNs()).toEqual([]);
  });
});
