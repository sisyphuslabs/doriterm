import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import { type JsonValue, type MachineView, MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { type MeshCalls, type MeshRead, MeshReader } from "./mesh-reader.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);
const OPEN = status.pending[0]?.nonce ?? "";
const OTHER = "ZXhwaXJlZCBqb2lu";

type Reply = (machines: readonly MachineView[]) => void;

/**
 * A core whose documents answer at once and whose machine.list replies are held: `nextRequest` resolves with the
 * reply of the next machine.list call the reader makes, and the test sends it when the ordering under test says so.
 */
function heldCore() {
  const docs = new Map<string, { value: JsonValue; version: number }>([
    [MESH_STATUS_DOC, { value: status, version: 1 }],
    [MESH_APPROVAL_DOC, { value: { deny: OTHER }, version: 1 }],
  ]);
  const unclaimed: Reply[] = [];
  const claims: ((reply: Reply) => void)[] = [];
  const calls: MeshCalls = {
    doc: async (name) => docs.get(name) ?? { value: null, version: 0 },
    setDoc: async (name, value, version) => {
      docs.set(name, { value, version: version + 1 });
    },
    machines: () =>
      new Promise((resolve) => {
        const claim = claims.shift();
        if (claim === undefined) unclaimed.push(resolve);
        else claim(resolve);
      }),
  };
  const nextRequest = (): Promise<Reply> =>
    new Promise((resolve) => {
      const reply = unclaimed.shift();
      if (reply === undefined) claims.push(resolve);
      else resolve(reply);
    });
  return { calls, nextRequest };
}

function shownBy(reader: MeshReader): { readonly reads: MeshRead[]; readonly stop: () => void } {
  const reads: MeshRead[] = [];
  return { reads, stop: reader.subscribe((read) => reads.push(read)) };
}

const answeredOf = (read: MeshRead | undefined) => (read?.phase === "ready" ? read.answered : undefined);
const APPROVED = { nonce: OPEN, verdict: "approve" } as const;
const CODE = "123 456";

describe("MeshReader", () => {
  test("approval carries the code the person compared and rejects a missing code before writing", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const answered = reader.answer(OPEN, "approve", CODE);
    (await nextRequest())([]);
    await answered;
    expect((await calls.doc(MESH_APPROVAL_DOC)).value).toEqual({ approve: OPEN, code: CODE });
    await expect(reader.answer(OTHER, "approve")).rejects.toThrow("code");
    expect((await calls.doc(MESH_APPROVAL_DOC)).value).toEqual({ approve: OPEN, code: CODE });
  });

  test("a read that started before an answer never replaces the answer's own read", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const periodic = reader.refresh();
    const periodicReply = await nextRequest();
    const answer = reader.answer(OPEN, "approve", CODE);
    const answerReply = await nextRequest();
    answerReply([]);
    await answer;
    expect(answeredOf(reads.at(-1))).toEqual(APPROVED);
    periodicReply([]);
    await periodic;
    expect([reads.length, answeredOf(reads.at(-1))]).toEqual([1, APPROVED]);
  });

  test("an answer settles with its own read shown, and a later read landing after it keeps the answer", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const answer = reader.answer(OPEN, "approve", CODE);
    const ownReply = await nextRequest();
    const later = reader.refresh();
    const laterReply = await nextRequest();
    ownReply([]);
    await answer;
    expect([reads.length, answeredOf(reads.at(-1))]).toEqual([1, APPROVED]);
    laterReply([]);
    await later;
    expect([reads.length, answeredOf(reads.at(-1))]).toEqual([2, APPROVED]);
  });

  test("a reader whose subscriber stopped shows nothing more", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const { reads, stop } = shownBy(reader);
    const read = reader.refresh();
    const reply = await nextRequest();
    stop();
    reply([]);
    await read;
    expect(reads).toEqual([]);
  });
});
