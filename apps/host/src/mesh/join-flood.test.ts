import { CloseCode } from "@doriface/crypto";
import { memoryLinkPair, type MemoryEnd } from "@doriface/crypto/testing";
import { MAX_RECORDS, parseRecord } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { failure, inviteDeps, joinerContext, ownOf, removeSides, runJoin, side } from "../testing/join-harness.ts";
import { signPubOf } from "../testing/mesh-history.ts";
import { runJoiner } from "./join.ts";
import { INVITER_EXPECTS, JOINER_EXPECTS, MAX_QUEUED_LINES, MeshLines } from "./lines.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
/** Lets every queued in-memory delivery run: they are microtasks, and a macrotask runs only after all of them. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const unread = (lines: MeshLines, count = 0): Promise<number> =>
  lines.next().then(
    () => unread(lines, count + 1),
    () => count,
  );
const flood = (end: MemoryEnd, line: string, times = 100): void => {
  for (let i = 0; i < times; i++) end.send(encode(`${line}\n`.repeat(1000)));
};

describe("section 10.2: a known line the join cannot consume closes the session with 4400", () => {
  test.each([
    ["done", '{"t":"done","mesh":"x"}'],
    ["records", '{"t":"records","records":[]}'],
    ["offer", '{"t":"offer","mesh":"m","inviter":"i","nonce":"n"}'],
    ["a second card", '{"t":"card","body":"b","sig":"s"}'],
  ])("%s lines while the join waits for approval close it, and the pending join is dropped", async (_, line) => {
    const [a, b] = [side("alpha"), side("beta")];
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    await pending.next();
    flood(run.joinerEnd, line);
    expect(await failure(run.invited)).toContain("the session closed before the join was decided");
    expect(run.inviterEnd.closeCode).toBe(CloseCode.CryptoFailure);
    expect(pending.list()).toEqual([]);
    expect(a.mesh.read()?.records.map((record) => parseRecord(record)?.type)).toEqual(["found"]);
  });

  test("an offer during the welcome closes the joiner's session", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const [inviterEnd, joinerEnd] = memoryLinkPair();
    const inviter = new MeshLines(inviterEnd, INVITER_EXPECTS);
    const joined = failure(runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), joinerContext(b, a)));
    const offer = { t: "offer", mesh: "m", inviter: signPubOf(a.m), nonce: "n" } as const;
    inviter.send(offer);
    await inviter.next();
    inviter.send(offer);
    expect(await joined).toBe("unexpected offer line");
    expect(joinerEnd.closeCode).toBe(CloseCode.CryptoFailure);
  });

  test("a welcome of more records than a mesh may hold closes the joiner's session", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    a.mesh.found(a.m.identity, ownOf(a));
    const [found] = a.mesh.read()?.records ?? [];
    if (found === undefined) throw new Error("no found");
    const [inviterEnd, joinerEnd] = memoryLinkPair();
    const inviter = new MeshLines(inviterEnd, INVITER_EXPECTS);
    const joined = failure(runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), joinerContext(b, a)));
    inviter.send({ t: "offer", mesh: a.mesh.read()?.meshId ?? "", inviter: signPubOf(a.m), nonce: "n" });
    await inviter.next();
    for (let sent = 0; sent <= MAX_RECORDS; sent += 256)
      inviter.send({ t: "records", records: Array(256).fill(found) });
    expect(await joined).toBe("the welcome holds more records than a mesh may");
    expect(joinerEnd.closeCode).toBe(CloseCode.CryptoFailure);
    expect(b.mesh.read()).toBeUndefined();
  });
});

describe("a welcome record over the record limits is refused as it is parsed", () => {
  test("a welcome record over a record's 2048-byte body closes the joiner's session with 4400 before done", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const [inviterEnd, joinerEnd] = memoryLinkPair();
    const inviter = new MeshLines(inviterEnd, INVITER_EXPECTS);
    const joined = failure(runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), joinerContext(b, a)));
    inviter.send({ t: "offer", mesh: "m", inviter: signPubOf(a.m), nonce: "n" });
    await inviter.next();
    const record = { body: "x".repeat(200 * 1024), sig: "A".repeat(86) };
    const paced = async (left: number): Promise<void> => {
      if (left === 0 || inviterEnd.closeCode !== undefined || joinerEnd.closeCode !== undefined) return;
      inviter.send({ t: "records", records: [record] });
      await settled();
      return paced(left - 1);
    };
    await paced(48);
    expect(await joined).toBe("malformed mesh line");
    expect(joinerEnd.closeCode).toBe(CloseCode.CryptoFailure);
  });
});

describe("the lines a session holds unread are bounded", () => {
  test("lines nobody reads close the session with 4400 once past the bound, holding no more than it", async () => {
    const [sender, receiver] = memoryLinkPair();
    const lines = new MeshLines(receiver, ["done"]);
    flood(sender, '{"t":"done","mesh":"x"}');
    await settled();
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
    expect(await unread(lines)).toBeLessThanOrEqual(MAX_QUEUED_LINES);
  });
});

describe("a session kept for sync no longer runs the join's parser", () => {
  test("after the welcome, a malformed line on either side closes nothing", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const pending = new PendingJoins();
    pending.setAuto(Date.now() + 60_000);
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    await Promise.all([run.invited, run.joined]);
    run.joinerEnd.send(encode("not a mesh line\n"));
    run.inviterEnd.send(encode("not a mesh line\n"));
    await settled();
    expect([run.inviterEnd.closeCode, run.joinerEnd.closeCode]).toEqual([undefined, undefined]);
  });
});
