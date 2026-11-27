import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import { type JsonValue, type MachineView, MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { type JoinRequest, type MeshCalls, type MeshRead, MeshReader } from "./mesh-reader.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);
const OPEN = status.pending[0]?.nonce ?? "";
const OTHER = "ZXhwaXJlZCBqb2lu";

type Reply = (machines: readonly MachineView[]) => void;

const machineView = (name: string, state: string): MachineView => ({
  name,
  state,
  host: name,
  id: `${name}-id`,
  target: "ssh build@10.0.0.2",
  version: "0.1.17",
});

/**
 * A core whose documents answer at once and whose machine.list replies are held: `nextRequest` resolves with the
 * reply of the next machine.list call the reader makes, and the test sends it when the ordering under test says so.
 */
/** A document's place in the held core: this core's, or another machine's by the name machine.list gives it. */
const key = (name: string, on?: string): string => `${on ?? ""}/${name}`;
const unreadable = new Set<string>();

function heldCore() {
  unreadable.clear();
  const docs = new Map<string, { value: JsonValue; version: number }>([
    [key(MESH_STATUS_DOC), { value: status, version: 1 }],
    [key(MESH_APPROVAL_DOC), { value: { deny: OTHER }, version: 1 }],
  ]);
  const unclaimed: Reply[] = [];
  const claims: ((reply: Reply) => void)[] = [];
  const calls: MeshCalls = {
    doc: async (name, on) => {
      if (on !== undefined && unreadable.has(on)) throw new Error(`${on} does not answer`);
      return docs.get(key(name, on)) ?? { value: null, version: 0 };
    },
    setDoc: async (name, value, version, on) => {
      docs.set(key(name, on), { value, version: version + 1 });
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
  return { calls, nextRequest, docs, unreadable };
}

function shownBy(reader: MeshReader): { readonly reads: MeshRead[]; readonly stop: () => void } {
  const reads: MeshRead[] = [];
  return { reads, stop: reader.subscribe((read) => reads.push(read)) };
}

const CODE = "123 456";
const answeredOf = (read: MeshRead | undefined) =>
  read?.phase === "ready" ? read.requests.find((request) => request.join.nonce === OPEN)?.answered : undefined;
const fixtureJoin = status.pending[0];
if (fixtureJoin === undefined) throw new Error("the fixture has a pending join");
// The host fixture's join carries no code; the one the person compared is what an approval sends.
const ownJoin = { ...fixtureJoin, code: CODE };
const OWN: JoinRequest = { join: ownJoin, machine: null, answered: undefined };
// The held core never plays the host, so an answer written through it stays unread: sent.
const APPROVED = { nonce: OPEN, verdict: "approve", outcome: { kind: "sent" } } as const;

describe("MeshReader", () => {
  test("approval carries the code the person compared and rejects a missing code before writing", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const answered = reader.answer(OWN, "approve");
    (await nextRequest())([]);
    await answered;
    expect((await calls.doc(MESH_APPROVAL_DOC)).value).toEqual({ approve: OPEN, code: CODE });
    const { code: _code, ...uncoded } = ownJoin;
    await expect(reader.answer({ ...OWN, join: { ...uncoded, nonce: OTHER } }, "approve")).rejects.toThrow("code");
    expect((await calls.doc(MESH_APPROVAL_DOC)).value).toEqual({ approve: OPEN, code: CODE });
  });

  test("a read that started before an answer never replaces the answer's own read", async () => {
    const { calls, nextRequest } = heldCore();
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const periodic = reader.refresh();
    const periodicReply = await nextRequest();
    const answer = reader.answer(OWN, "approve");
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
    const answer = reader.answer(OWN, "approve");
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

  test.each([
    [{ approve: OPEN, code: CODE, decided: true }, { kind: "taken" }],
    [{ approve: OPEN, code: CODE, decided: false }, { kind: "gone" }],
    [
      { approve: OPEN, code: "654 321", error: "the approval code does not match this join" },
      { kind: "refused", reason: "the approval code does not match this join" },
    ],
    [{ deny: OPEN, decided: true }, { kind: "taken" }],
  ] as const)("reads what the host wrote back beside the answer (#2936): %j", async (written, outcome) => {
    const { calls, nextRequest } = heldCore();
    await calls.setDoc(MESH_APPROVAL_DOC, written, 1);
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const read = reader.refresh();
    (await nextRequest())([]);
    await read;
    expect(answeredOf(reads.at(-1))?.outcome).toEqual(outcome);
  });

  test("a join held on another connected machine is listed with it, and answered through that machine (#2939)", async () => {
    const { calls, nextRequest, docs } = heldCore();
    const held = { ...ownJoin, nonce: "aGVsZCBlbHNld2hlcmU", name: "qa-phone" };
    docs.set(key(MESH_STATUS_DOC, "build-box"), { value: { ...status, pending: [held] }, version: 1 });
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const read = reader.refresh();
    (await nextRequest())([machineView("build-box", "connected"), machineView("laptop", "unreachable")]);
    await read;
    const last = reads.at(-1);
    const requests = last?.phase === "ready" ? last.requests : [];
    expect(requests.map((request) => [request.join.name, request.machine?.name ?? null])).toEqual([
      ["ci-runner", null],
      ["qa-phone", "build-box"],
    ]);
    const elsewhere = requests[1];
    if (elsewhere === undefined) throw new Error("the held join is listed");
    const answered = reader.answer(elsewhere, "approve");
    (await nextRequest())([machineView("build-box", "connected")]);
    await answered;
    expect(docs.get(key(MESH_APPROVAL_DOC, "build-box"))?.value).toEqual({ approve: held.nonce, code: CODE });
    expect(docs.get(key(MESH_APPROVAL_DOC))?.value).toEqual({ deny: OTHER });
  });

  test("a connected machine whose documents cannot be read is named, not dropped in silence", async () => {
    const { calls, nextRequest } = heldCore();
    unreadable.add("build-box");
    const reader = new MeshReader(calls);
    const { reads } = shownBy(reader);
    const read = reader.refresh();
    (await nextRequest())([machineView("build-box", "connected")]);
    await read;
    const last = reads.at(-1);
    expect(last?.phase === "ready" ? last.unread : undefined).toEqual(["build-box"]);
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
