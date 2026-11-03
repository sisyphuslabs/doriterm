import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import { type JsonValue, type MachineView, MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { type MeshCalls, type MeshRead, MeshReader } from "./mesh-reader.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);
const OPEN = status.pending[0]?.nonce ?? "";
const OTHER = "ZXhwaXJlZCBqb2lu";

/** A core whose documents answer at once, and whose machine.list replies wait until the test releases them. */
function heldCore() {
  const docs = new Map<string, { value: JsonValue; version: number }>([
    [MESH_STATUS_DOC, { value: status, version: 1 }],
    [MESH_APPROVAL_DOC, { value: { deny: OTHER }, version: 1 }],
  ]);
  const held: ((machines: readonly MachineView[]) => void)[] = [];
  const calls: MeshCalls = {
    doc: async (name) => docs.get(name) ?? { value: null, version: 0 },
    setDoc: async (name, value, version) => {
      docs.set(name, { value, version: version + 1 });
    },
    machines: () => new Promise((resolve) => held.push(resolve)),
  };
  return { calls, held };
}

const answeredOf = (read: MeshRead | undefined) => (read?.phase === "ready" ? read.answered : undefined);

/** Lets queued promise jobs run until `count` machine.list replies are held. */
async function heldReplies(held: readonly unknown[], count: number): Promise<void> {
  if (held.length >= count) return;
  await Promise.resolve();
  return heldReplies(held, count);
}

describe("MeshReader", () => {
  test("a read that started before an answer never replaces the answer's own read", async () => {
    const { calls, held } = heldCore();
    const reads: MeshRead[] = [];
    const reader = new MeshReader(calls, (read) => reads.push(read));
    const periodic = reader.refresh();
    const answer = reader.answer(OPEN, "approve");
    await heldReplies(held, 2);
    held[1]?.([]);
    await answer;
    expect(answeredOf(reads.at(-1))).toEqual({ nonce: OPEN, verdict: "approve" });
    held[0]?.([]);
    await periodic;
    expect(answeredOf(reads.at(-1))).toEqual({ nonce: OPEN, verdict: "approve" });
  });

  test("an answer settles only once a read started after its write has been shown", async () => {
    const { calls, held } = heldCore();
    const reads: MeshRead[] = [];
    const reader = new MeshReader(calls, (read) => reads.push(read));
    let settled = false;
    const answer = (async () => {
      await reader.answer(OPEN, "approve");
      settled = true;
    })();
    await heldReplies(held, 1);
    const later = reader.refresh();
    await heldReplies(held, 2);
    held[0]?.([]);
    await Promise.resolve();
    expect(settled).toBe(false);
    held[1]?.([]);
    await Promise.all([answer, later]);
    expect([settled, answeredOf(reads.at(-1))]).toEqual([true, { nonce: OPEN, verdict: "approve" }]);
  });

  test("a closed reader shows nothing more", async () => {
    const { calls, held } = heldCore();
    const reads: MeshRead[] = [];
    const reader = new MeshReader(calls, (read) => reads.push(read));
    const read = reader.refresh();
    await heldReplies(held, 1);
    reader.close();
    held[0]?.([]);
    await read;
    expect(reads).toEqual([]);
  });
});
