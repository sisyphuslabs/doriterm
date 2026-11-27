import { expect, test } from "bun:test";
import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { approveReadmit, signBundleChallenge, signReadmit, type ReadmitFields } from "@doriface/mesh";

function setup() {
  const old = generateHostIdentity();
  const other = generateHostIdentity();
  const fresh = generateHostIdentity();
  const pub = (identity: typeof old) => base64urlEncode(identity.sign.publicKey);
  const mesh = "a".repeat(26);
  const fields: ReadmitFields = {
    old: pub(old),
    signPub: pub(fresh),
    noise: base64urlEncode(fresh.noise.publicKey),
    name: "phone",
    nonce: base64urlEncode(new Uint8Array(16).fill(7)),
    at: 1_795_747_200_000,
  };
  const request = {
    ...fields,
    oldSig: signReadmit(mesh, fields, old.sign.secretKey),
    newSig: signReadmit(mesh, fields, fresh.sign.secretKey),
  };
  const members = {
    old: { signPub: pub(old), devicePub: base64urlEncode(old.noise.publicKey) },
    other: { signPub: pub(other), devicePub: base64urlEncode(other.noise.publicKey) },
  };
  const proof = (who: typeof old) => ({ by: pub(who), sig: approveReadmit(mesh, fields, who.sign.secretKey) });
  return { mesh, request, members, proof, old, other, pub };
}

test("M13: a live old client stays required after going offline; denial is final for this request", async () => {
  const { RestoreRequests } = await import("./requests.ts");
  const f = setup();
  const pending = new RestoreRequests();
  const clients = [{ ...f.members.old, live: true }];
  expect(pending.offer(f.mesh, f.request, clients)).toEqual({ kind: "waiting" });
  expect(pending.forClient(f.members.old.signPub)).toHaveLength(1);
  expect(pending.offer(f.mesh, f.request, [{ ...f.members.old, live: false }])).toEqual({ kind: "waiting" });
  expect(pending.answer(f.mesh, f.request, f.members.old.signPub, null)).toBe(true);
  expect(pending.offer(f.mesh, f.request, [{ ...f.members.old, live: false }])).toEqual({ kind: "denied" });
});

test("R2/M13: an offline other client blocks; when both participate, old approval comes first and is not enough", async () => {
  const { RestoreRequests } = await import("./requests.ts");
  const f = setup();
  const pending = new RestoreRequests();
  const clients = [
    { ...f.members.old, live: true },
    { ...f.members.other, live: false },
  ];
  expect(pending.offer(f.mesh, f.request, clients)).toEqual({ kind: "waiting" });
  expect(pending.forClient(f.members.other.signPub)).toEqual([]);
  expect(pending.answer(f.mesh, f.request, f.members.old.signPub, f.proof(f.old))).toBe(true);
  expect(pending.offer(f.mesh, f.request, clients)).toEqual({ kind: "waiting" });
  expect(pending.forClient(f.members.other.signPub)).toHaveLength(1);
  expect(pending.answer(f.mesh, f.request, f.members.other.signPub, f.proof(f.other))).toBe(true);
  expect(pending.offer(f.mesh, f.request, clients)).toEqual({
    kind: "approved",
    proof: { ...f.request, oldApproval: f.proof(f.old).sig, approval: f.proof(f.other) },
  });
});

test("C2: invalid continuity or possession never creates a prompt, with a valid control", async () => {
  const { RestoreRequests } = await import("./requests.ts");
  const f = setup();
  const pending = new RestoreRequests();
  const clients = [{ ...f.members.old, live: true }];
  const bad = f.proof(f.other).sig;
  for (const request of [
    { ...f.request, oldSig: bad },
    { ...f.request, newSig: bad },
    { ...f.request, old: f.members.other.signPub },
  ]) {
    expect(pending.offer(f.mesh, request, clients)).toEqual({ kind: "empty" });
    expect(pending.forClient(f.members.old.signPub)).toEqual([]);
  }
  expect(pending.offer(f.mesh, f.request, clients)).toEqual({ kind: "waiting" });
});

test("M15: only a current client may answer this holder's fresh bundle challenge", async () => {
  const { mayReadBundle } = await import("./requests.ts");
  const f = setup();
  const challenge = base64urlEncode(new Uint8Array(32).fill(9));
  const current = new Set([f.members.old.signPub]);
  const sig = signBundleChallenge(challenge, f.old.sign.secretKey);
  expect(mayReadBundle(current, { challenge, old: f.members.old.signPub, sig })).toBe(true);
  expect(mayReadBundle(new Set(), { challenge, old: f.members.old.signPub, sig })).toBe(false);
  expect(mayReadBundle(current, { challenge: `${challenge}A`, old: f.members.old.signPub, sig })).toBe(false);
  expect(mayReadBundle(current, { challenge, old: f.members.old.signPub, sig: f.request.oldSig })).toBe(false);
});
