import type { MeshChannel, MeshMessage } from "../sync-lines.ts";
import { mergeBatch } from "../merge.ts";
import { type SyncHost, SyncSession } from "../sync.ts";
import type { MeshRecord } from "../upstream.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeSigner, fakeRules, MemoryFile, MESH_ID, meshOf, member } from "./fake-mesh.ts";

export interface Close {
  readonly code: number;
  readonly reason: string;
}

/** A channel the test speaks for: what the session sends is kept, and `receive` hands it a line from the peer. */
export interface Scripted {
  readonly channel: MeshChannel;
  readonly sent: MeshMessage[];
  readonly closes: Close[];
  receive(message: MeshMessage): void;
}

export function scripted(): Scripted {
  const sent: MeshMessage[] = [];
  const closes: Close[] = [];
  const listeners = new Set<(message: MeshMessage) => void>();
  const channel: MeshChannel = {
    send: (message) => void sent.push(message),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
    close: (code = 1000, reason = "") => void closes.push({ code, reason }),
  };
  return { channel, sent, closes, receive: (message) => listeners.forEach((listener) => listener(message)) };
}

/** Member b's side of a session that a (the founder) opened, over b's own copy of the mesh. */
export interface ScriptedSession extends Scripted {
  readonly session: SyncSession;
  readonly file: MemoryFile;
  readonly batchSizes: number[];
}

export function sessionAtB(records?: readonly MeshRecord[]): ScriptedSession {
  const [a, b] = [member("a"), member("b")];
  const file = new MemoryFile(records ?? meshOf([a, b]));
  const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 1) };
  const batchSizes: number[] = [];
  const host: SyncHost = {
    meshId: MESH_ID,
    rules: fakeRules,
    records: () => file.read().records,
    merge: (_session, batch) => {
      batchSizes.push(batch.length);
      return mergeBatch(deps, batch);
    },
    heard: () => undefined,
    ended: () => undefined,
  };
  const script = scripted();
  const ends = { peer: a.signPub, dialer: a.signPub, sweeping: false };
  const session = new SyncSession(ends, script.channel, host, new FakeClock());
  session.start();
  return { ...script, session, file, batchSizes };
}
