import { base64urlEncode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { joinCode, joinCommit, MeshLines } from "@doriface/mesh/join";
import { afterEach, expect, test } from "bun:test";
import { cardBody } from "../state/mesh.ts";
import { failure, inviteDeps, removeSides, side } from "../testing/join-harness.ts";
import { noiseOf } from "../testing/mesh-history.ts";
import { serveJoin } from "./invite.ts";
import { PendingJoins } from "./pending-joins.ts";
import { JoinResumes } from "./join-resumes.ts";

afterEach(removeSides);
const h = new Uint8Array(32).fill(11);
const Nj = new Uint8Array(32).fill(12);

async function begin(auto = false, kind: "client" | "machine" = "client", sas = true) {
  const a = side("alpha");
  const c = side("browser");
  const pending = new PendingJoins();
  if (auto) pending.setAuto(Date.now() + 60_000);
  const resumes = new JoinResumes();
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const client = new MeshLines(clientEnd, ["offer", "reveal", "records", "done", "refused"]);
  const deps = { ...inviteDeps(a, pending), handshakeHash: h, resumes, formatReady: () => true };
  const served = failure(serveJoin(new MeshLines(hostEnd, ["card", "refused"]), c.m.identity.noise.publicKey, deps));
  const offer = await client.next();
  if (offer.t !== "offer") throw new Error("no offer");
  const card = signCard(cardBody(c.m.identity, {
    name: "browser", hcId: kind === "client" ? "" : "core-browser", devicePub: noiseOf(c.m),
  }, offer.mesh, offer.inviter, offer.nonce, kind), c.m.identity.sign.secretKey);
  client.send({ t: "card", ...card, ...(sas ? { sas: base64urlEncode(Nj) } : {}) });
  return { a, c, pending, resumes, client, hostEnd, clientEnd, deps, offer, served };
}

test("an auto offer refuses a client before creating any pending join", async () => {
  const run = await begin(true);
  expect(run.offer.commit).toBeUndefined();
  expect(await run.served).toContain("this invite is for a machine");
  expect(run.pending.list()).toEqual([]);
  expect(run.a.mesh.read()?.records).toHaveLength(1);
});

test("an asking offer reveals its commitment and both ends derive the pending code", async () => {
  const run = await begin();
  const reveal = await run.client.next();
  if (reveal.t !== "reveal") throw new Error("no reveal");
  const Ni = Uint8Array.fromBase64(reveal.Ni, { alphabet: "base64url" });
  expect(joinCommit(h, Ni)).toBe(run.offer.commit ?? "");
  const asked = await run.pending.next();
  expect(asked.code).toBe(joinCode(h, Ni, Nj));
  run.pending.decide(asked.nonce, false);
  expect(await run.served).toContain("denied");
});

test.each(["approve-first", "confirm-first"] as const)("%s admits once and only after both decisions", async (order) => {
  const run = await begin();
  await run.client.next();
  const asked = await run.pending.next();
  if (order === "approve-first") run.pending.decide(asked.nonce, true, asked.code);
  else run.client.send({ t: "confirm" });
  expect(run.a.mesh.read()?.records).toHaveLength(1);
  if (order === "approve-first") run.client.send({ t: "confirm" });
  else run.pending.decide(asked.nonce, true, asked.code);
  expect(await run.served).toBe("resolved");
  expect(run.a.mesh.read()?.records).toHaveLength(2);
  run.resumes.clear();
});

test("abort withdraws the pending join and signs nothing", async () => {
  const run = await begin();
  await run.client.next();
  run.client.send({ t: "abort" });
  expect(await run.served).toContain("not joined");
  expect(run.pending.list()).toEqual([]);
  expect(run.a.mesh.read()?.records).toHaveLength(1);
});

test("an older card without sas spends the offer and gets the update sentence", async () => {
  const run = await begin(false, "machine", false);
  expect(await run.served).toContain("too old to join on an invite that asks");
  expect(run.pending.list()).toEqual([]);
  expect(run.a.mesh.read()?.records).toHaveLength(1);
});

test("dropping after the card keeps the pending join and its original reveal for resume", async () => {
  const run = await begin();
  const reveal = await run.client.next();
  const asked = await run.pending.next();
  run.clientEnd.close();
  expect(await run.served).not.toBe("resolved");
  expect(run.pending.list()).toHaveLength(1);
  const retained = run.resumes.get(asked.nonce, noiseOf(run.c.m));
  expect(retained?.Ni).toBe(reveal.t === "reveal" ? reveal.Ni : "");
  expect(run.resumes.get("wrong", noiseOf(run.c.m))).toBeUndefined();
  expect(run.resumes.get(asked.nonce, "other-key")).toBeUndefined();
  run.pending.decide(asked.nonce, false);
  run.resumes.clear();
});
