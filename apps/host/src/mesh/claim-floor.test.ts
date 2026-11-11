import { describe, expect, test } from "bun:test";
import { CloseCode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord } from "@doriface/mesh";
import { CounterBehindError } from "../state/mesh.ts";
import type { MeshLine } from "./lines.ts";
import { checkFloor } from "./merge.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

const [a, b] = [peer("a"), peer("b")];
const rename = { type: "name", signPub: b.signPub, name: "b" } as const;
const KEEP_ALIVE_MS = 10_000;
/** docs/transport.md: a claim expires 30 s without its records; the claimer is then ignored for 10 minutes. */
const CLAIM_MS = 30_000;
const COOLDOWN_MS = 600_000;
const CLAIM = { [b.signPub]: Number.MAX_SAFE_INTEGER };
/** Every 10 s through the first window and a little past it, then once a minute: each signing writes mesh.json. */
const sampled = (at: number): boolean => at < 50_000 || at % 60_000 === 0;
/** The a-and-b mesh's records, signed once for the file: every case below starts from this mesh (#780). */
const MESH = meshOf([a, b]);

/** b's mesh with a; `connect()` opens one more sync session a dialed to b, and the test speaks for a on it. */
function meshAtB(seed: number) {
  const { records } = MESH;
  const clock = new FakeClock();
  const host = new MeshNet(clock, seededRandom(seed)).add(b, records);
  const mesh = host.gossip.meshId;
  const connect = () => {
    const [ours, theirs] = memoryLinkPair(true);
    host.gossip.attach(a.signPub, a.signPub, ours);
    const say = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    const hello = (n: Readonly<Record<string, number>>): void =>
      say({ t: "hello", v: 2, mesh, heads: headsOfRecords(records), n });
    return { ours, hello, done: () => say({ t: "done", mesh }) };
  };
  /** Whether b signs an own record now; the refusal's message when it does not. */
  const signs = (): true | string => {
    try {
      host.gossip.append(rename);
      return true;
    } catch (error) {
      if (error instanceof CounterBehindError) return error.message;
      throw error;
    }
  };
  /**
   * Whether b would refuse to sign an own record now, decided as `append` decides it (the floor the claims hold against
   * b's counter), without signing one: a signature, its check at the door and two writes per sample are what made a
   * 10-minute run cost seconds on a loaded host, and none of them is what the H-2 case is about (#780).
   */
  const refuses = (): boolean => {
    try {
      checkFloor(host.records(), b.signPub, host.gossip.floor());
      return false;
    } catch (error) {
      if (error instanceof CounterBehindError) return true;
      throw error;
    }
  };
  const ownNs = (): readonly number[] =>
    (host.store.read()?.records ?? []).flatMap((record) => {
      const body = parseRecord(record);
      return body?.by === b.signPub ? [body.n] : [];
    });
  return { clock, connect, signs, refuses, ownNs };
}

describe("a peer's hello.n claim on this host's counter (section 10.1, M-E1)", () => {
  test("a done resolves nothing by itself: a claim none of whose records arrive expires at 30 s", async () => {
    const s = meshAtB(51);
    const session = s.connect();
    session.hello({ [b.signPub]: 7 });
    await s.clock.advance(1);
    expect(s.signs()).toStartWith(`${a.name} holds counter 7 of this host's key, here 0: syncing before signing`);
    session.done();
    await s.clock.advance(CLAIM_MS - 2);
    expect(s.signs()).toStartWith(`${a.name} holds counter 7 of this host's key, here 0: syncing before signing`);
    await s.clock.advance(1);
    expect(s.signs()).toBe(true);
    expect(s.ownNs()).toEqual([1]);
  });

  test("a claimer that keeps the session up with hellos but never answers is closed 4400 at 30 s", async () => {
    const s = meshAtB(52);
    const session = s.connect();
    const keepAlive = async (left: number): Promise<void> => {
      session.hello(CLAIM);
      if (left <= KEEP_ALIVE_MS) return s.clock.advance(left);
      await s.clock.advance(KEEP_ALIVE_MS);
      return keepAlive(left - KEEP_ALIVE_MS);
    };
    await keepAlive(CLAIM_MS - 1);
    expect(s.signs()).not.toBe(true);
    expect(session.ours.closeCode).toBeUndefined();
    await s.clock.advance(1);
    expect(session.ours.closeCode).toBe(CloseCode.CryptoFailure);
    expect(s.signs()).toBe(true);
  });

  test("a claim made after answering this host's hello makes the claimer owe a done: none in 30 s closes 4400, and its claims are then ignored for 10 minutes", async () => {
    const s = meshAtB(53);
    const session = s.connect();
    session.done();
    session.hello(CLAIM);
    await s.clock.advance(CLAIM_MS - 1);
    expect(s.signs()).not.toBe(true);
    expect(session.ours.closeCode).toBeUndefined();
    await s.clock.advance(1);
    expect(session.ours.closeCode).toBe(CloseCode.CryptoFailure);
    // Whether b signs now, decided as `append` decides it, without the signature and its writes (#780).
    expect(s.refuses()).toBe(false);
    s.connect().hello(CLAIM);
    await s.clock.advance(1);
    expect(s.refuses()).toBe(false);
    await s.clock.advance(COOLDOWN_MS);
    s.connect().hello(CLAIM);
    await s.clock.advance(1);
    expect(s.signs()).not.toBe(true);
  });

  test("a claimer that redials after every close holds the floor for 30 s in 10 minutes, not the whole time (H-2)", async () => {
    const s = meshAtB(54);
    const refused: number[] = [];
    const claimFrom = async (session: ReturnType<typeof s.connect>, at: number): Promise<void> => {
      if (at >= COOLDOWN_MS) return;
      const open = session.ours.closeCode === undefined ? session : s.connect();
      open.hello(CLAIM);
      await s.clock.advance(1);
      if (sampled(at) && s.refuses()) refused.push(at);
      await s.clock.advance(KEEP_ALIVE_MS - 1);
      return claimFrom(open, at + KEEP_ALIVE_MS);
    };
    await claimFrom(s.connect(), 0);
    expect(refused).toEqual([0, 10_000, 20_000]);
  });

  test("every hello is answered with done, even when the peer lacks nothing", async () => {
    const s = meshAtB(55);
    const toA: string[] = [];
    const session = s.connect();
    session.ours.tap = (bytes) => {
      for (const text of new TextDecoder().decode(bytes).split("\n").filter(Boolean)) {
        const line: MeshLine = JSON.parse(text);
        toA.push(line.t);
      }
      return [bytes];
    };
    session.hello({});
    await s.clock.advance(1);
    expect(toA).toEqual(["done"]);
  });
});
