import { describe, expect, test } from "bun:test";
import {
  MAX_LINE_BYTES,
  type MeshChannel,
  type MeshMessage,
  MeshStreamError,
  parseMessage,
  recordLines,
} from "./sync-lines.ts";
import { mergeBatch } from "./merge.ts";
import { type SyncHost, SyncSession } from "./sync.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { FakeSigner, fakeRules, hashOfRecord, MemoryFile, MESH_ID, meshOf, member } from "./testing/fake-mesh.ts";

function scripted(): { channel: MeshChannel; sent: MeshMessage[]; receive: (message: MeshMessage) => void } {
  const sent: MeshMessage[] = [];
  const listeners = new Set<(message: MeshMessage) => void>();
  const channel: MeshChannel = {
    send: (message) => void sent.push(message),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
    close: () => undefined,
  };
  return { channel, sent, receive: (message) => listeners.forEach((listener) => listener(message)) };
}

describe("mesh stream lines (S-1)", () => {
  test("a large set goes as several records lines of at most 256 KiB, then done", () => {
    const signer = new FakeSigner(member("a"), 1);
    const records = Array.from({ length: 300 }, (_, i) => signer.name([], `${"n".repeat(1500)}${i}`));
    const lines = recordLines(records);
    const encoded = lines.map((message) => new TextEncoder().encode(`${JSON.stringify(message)}\n`).byteLength);
    expect(lines.length).toBeGreaterThan(2);
    expect(Math.max(...encoded)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(lines.at(-1)).toEqual({ t: "done" });
    expect(lines.flatMap((message) => (message.t === "records" ? message.records : []))).toEqual(records);
  });

  test("an unknown t is ignored and a malformed line is refused", () => {
    expect(parseMessage('{"t":"later-feature","x":1}')).toBeUndefined();
    expect(() => parseMessage('{"t":"want","hashes":[1]}')).toThrow(MeshStreamError);
    expect(() => parseMessage("not json")).toThrow(MeshStreamError);
  });
});

describe("a sync session (S-1)", () => {
  test("asks once per session for a dangling record's past, and stores both when it comes", () => {
    const [a, b] = [member("a"), member("b")];
    const file = new MemoryFile(meshOf([a, b]));
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 1) };
    const founder = new FakeSigner(a, 2);
    const parent = founder.admit(member("c"), fakeRules.headsOf(file.read().records));
    const child = founder.admit(member("e"), [hashOfRecord(parent)]);
    const host: SyncHost = {
      meshId: MESH_ID,
      rules: fakeRules,
      records: () => file.read().records,
      merge: (_session, batch) => mergeBatch(deps, batch),
      heard: () => undefined,
      ended: () => undefined,
    };
    const { channel, sent, receive } = scripted();
    const session = new SyncSession(
      { peer: a.signPub, dialer: a.signPub, sweeping: false },
      channel,
      host,
      new FakeClock(),
    );
    session.start();
    receive({ t: "records", records: [child] });
    receive({ t: "done" });
    receive({ t: "records", records: [child] });
    receive({ t: "done" });
    const wants = sent.filter((message) => message.t === "want");
    expect(wants).toEqual([{ t: "want", hashes: [hashOfRecord(parent)] }]);
    receive({ t: "records", records: [parent] });
    receive({ t: "done" });
    const stored = file.read().records.map(hashOfRecord);
    expect(stored).toContain(hashOfRecord(parent));
    expect(stored).toContain(hashOfRecord(child));
  });
});
