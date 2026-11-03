import { memoryLinkPair } from "@doriface/crypto/testing";
import type { Signed } from "@doriface/mesh";
import type { MeshLine } from "../lines.ts";
import { mergeBatch } from "../merge.ts";
import { type SyncHost, SyncSession } from "../sync.ts";
import type { MeshStore } from "../../state/mesh.ts";
import { FakeClock, settle } from "./fake-clock.ts";
import { meshIdOfRecords, meshOf, peer, storeOf } from "./mesh-peers.ts";

/** Member b's side of a sync session that a (the founder) opened, over b's own mesh.json; the test speaks for a. */
export interface ScriptedSession {
  readonly session: SyncSession;
  readonly store: MeshStore;
  readonly meshId: string;
  readonly batchSizes: number[];
  readonly sent: MeshLine[];
  readonly clock: FakeClock;
  closedWith(): number | undefined;
  receive(line: MeshLine): void;
  settled(): Promise<void>;
}

export function sessionAtB(
  records?: readonly Signed[],
  options: { readonly waitForHello?: boolean; readonly merge?: SyncHost["merge"] } = {},
): ScriptedSession {
  const [a, b] = [peer("a"), peer("b")];
  const set = records ?? meshOf([a, b]).records;
  const meshId = meshIdOfRecords(set);
  const store = storeOf(b, set);
  const deps = { store, identity: b.machine.identity, meshId };
  const batchSizes: number[] = [];
  const host: SyncHost = {
    meshId,
    records: () => store.read()?.records ?? [],
    merge: (session, batch) => {
      batchSizes.push(batch.length);
      return options.merge?.(session, batch) ?? mergeBatch(deps, batch);
    },
    heard: () => undefined,
    ended: () => undefined,
  };
  const [ours, theirs] = memoryLinkPair(true);
  const sent: MeshLine[] = [];
  const decoder = new TextDecoder();
  ours.tap = (bytes) => {
    for (const text of decoder
      .decode(bytes)
      .split("\n")
      .filter((part) => part !== ""))
      sent.push(JSON.parse(text));
    return [bytes];
  };
  const clock = new FakeClock();
  const session = new SyncSession({ peer: a.signPub, dialer: a.signPub, sweeping: false }, ours, host, clock);
  session.start(options.waitForHello === true);
  const encoder = new TextEncoder();
  return {
    session,
    store,
    meshId,
    batchSizes,
    sent,
    clock,
    closedWith: () => ours.closeCode,
    receive: (line) => theirs.send(encoder.encode(`${JSON.stringify(line)}\n`)),
    settled: () => settle(),
  };
}
