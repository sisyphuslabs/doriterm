import { memoryLinkPair } from "@doriface/crypto/testing";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { CounterBehindError } from "../../state/mesh.ts";
import { DialPolicy } from "../dial-policy.ts";
import { Gossip } from "../gossip.ts";
import type { MeshLine } from "../lines.ts";
import { FakeClock, seededRandom } from "./fake-clock.ts";
import { headsOfRecords, meshIdOfRecords, meshOf, peer, type Peer, Signer, storeOf } from "./mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const COOLDOWN = "ignored for 10 minutes";

/** b holding `records`, with its log; `connect(from)` opens a session `from` dialed to b, and the test speaks for it. */
export function hostB(records: readonly Signed[], seed: number) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const store = storeOf(b, records);
  const meshId = meshIdOfRecords(records);
  const gossip = new Gossip({
    store,
    identity: b.machine.identity,
    meshId,
    clock,
    random: seededRandom(seed),
    policy: new DialPolicy({ clock, random: seededRandom(seed + 1), onDue: () => undefined }),
    dial: () => Promise.reject(new Error("b dials nobody here")),
    log: (line) => void logs.push(line),
  });
  const stored = (): readonly Signed[] => store.read()?.records ?? [];
  const connect = (from: Peer = a, heads: readonly string[] = headsOfRecords(stored())) => {
    const [ours, theirs] = memoryLinkPair(true);
    gossip.attach(from.signPub, from.signPub, ours);
    const say = (line: MeshLine): void => theirs.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    return {
      hello: (n: Readonly<Record<string, number>>) => say({ t: "hello", v: 2, mesh: meshId, heads, n }),
      send: (...sent: readonly Signed[]) => say({ t: "records", records: sent }),
      done: () => say({ t: "done", mesh: meshId }),
    };
  };
  let renames = 0;
  const signs = (): boolean => {
    try {
      gossip.append({ type: "name", signPub: b.signPub, name: `b${(renames += 1)}` });
      return true;
    } catch (error) {
      if (error instanceof CounterBehindError) return false;
      throw error;
    }
  };
  const own = (): readonly { readonly n: number; readonly type: string }[] =>
    stored().flatMap((record) => {
      const body = parseRecord(record);
      return body?.by === b.signPub ? [{ n: body.n, type: body.type }] : [];
    });
  const ownNs = (): readonly number[] => own().map((record) => record.n);
  const cooldowns = (): number => logs.filter((line) => line.includes(COOLDOWN)).length;
  const at = async (ms: number): Promise<void> => clock.advance(ms - clock.now());
  /** Stores records past gossip's merge (no counter catch-up), as only a store-level merge would. */
  const storeOnly = (batch: readonly Signed[]): void => void store.merge(batch);
  return { gossip, stored, connect, signs, own, ownNs, cooldowns, at, storeOnly };
}

/** b restored from a backup taken before its own records `1..count`: a holds them, each acking the one before. */
export function restored(count: number) {
  const { records } = meshOf([a, b, c]);
  const signer = new Signer(b, records);
  const chain: Signed[] = [];
  for (let i = 0; i < count; i++) {
    const last = chain.at(-1);
    chain.push(signer.ack(last === undefined ? headsOfRecords(records) : [hashOf(last)]));
  }
  return { records, chain, heads: headsOfRecords([...records, ...chain]) };
}
