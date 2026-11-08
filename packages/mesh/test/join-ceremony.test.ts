import { base64urlEncode, generateHostIdentity, rawStaticKey, secureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { expect, test } from "bun:test";
import {
  type JoinAnchor,
  joinCode,
  joinCommit,
  JOINER_EXPECTS,
  MeshLines,
  runJoinCeremony,
} from "../src/join/index.ts";

const h = new Uint8Array(32).fill(1);
const Ni = new Uint8Array(32).fill(2);
const offer = { t: "offer", mesh: "mesh", inviter: "inviter", nonce: "nonce", commit: joinCommit(h, Ni) } as const;
const card = { body: "signed body", sig: "signature" };
const dialed = { hostId: "inviter", noisePub: base64urlEncode(h) };
const failureOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "unexpected success",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

function ceremony(confirm: ((code: string) => Promise<boolean>) | undefined = async () => true) {
  const [hostEnd, clientEnd] = memoryLinkPair();
  const host = new MeshLines(hostEnd, ["card", "confirm", "abort", "refused", "resume"]);
  const client = new MeshLines(clientEnd, JOINER_EXPECTS);
  let anchor: JoinAnchor | undefined;
  const options = {
    kind: "client" as const,
    handshakeHash: h,
    dialed,
    expiresAt: Date.now() + 60_000,
    yes: false,
    confirm,
    card: async () => card,
    saveAnchor: async (value: JoinAnchor) => {
      anchor = value;
    },
    clearAnchor: async () => {
      anchor = undefined;
    },
  };
  return { host, client, hostEnd, clientEnd, options, anchor: () => anchor };
}

test("a real secureLink pair computes one code and saves the anchor before its card", async () => {
  const a = generateHostIdentity();
  const b = generateHostIdentity();
  const [aEnd, bEnd] = memoryLinkPair();
  const linkSecret = new Uint8Array(32).fill(7);
  const [aSecure, bSecure] = await Promise.all([
    secureLink(aEnd, {
      role: "responder",
      hostId: a.hostId,
      staticKey: rawStaticKey(a.noise),
      authorize: () => ({ accept: true, secret: { mode: "link", linkSecret } }),
    }),
    secureLink(bEnd, {
      role: "initiator",
      hostId: a.hostId,
      staticKey: rawStaticKey(b.noise),
      remoteStatic: a.noise.publicKey,
      pairing: { mode: "link", linkSecret, name: "browser" },
      stream: "mesh",
    }),
  ]);
  const host = new MeshLines(aSecure, ["card", "confirm"]);
  const client = new MeshLines(bSecure, JOINER_EXPECTS);
  let saved: JoinAnchor | undefined;
  let shown: string | undefined;
  const done = runJoinCeremony(client, {
    kind: "client",
    handshakeHash: bSecure.handshakeHash,
    dialed,
    yes: false,
    expiresAt: Date.now() + 60_000,
    card: async () => {
      expect(saved?.offer.nonce).toBe("nonce");
      return card;
    },
    confirm: async (code) => {
      shown = code;
      return true;
    },
    saveAnchor: async (anchor) => {
      saved = anchor;
    },
    clearAnchor: async () => {
      saved = undefined;
    },
  });
  host.send({ ...offer, commit: joinCommit(aSecure.handshakeHash, Ni) });
  const received = await host.next();
  if (received.t !== "card" || received.sas === undefined) throw new Error("no contribution");
  host.send({ t: "reveal", Ni: base64urlEncode(Ni) });
  expect(await host.next()).toEqual({ t: "confirm" });
  expect(shown).toBe(
    joinCode(aSecure.handshakeHash, Ni, Uint8Array.fromBase64(received.sas, { alphabet: "base64url" })),
  );
  host.send({ t: "done", mesh: "mesh" });
  expect((await done).records).toEqual([]);
  aSecure.close();
});

test.each([false, true])("an offer that asks never uses yes=%s to answer the code", async (yes) => {
  const run = ceremony(async () => false);
  const done = runJoinCeremony(run.client, { ...run.options, yes });
  const failure = failureOf(done);
  run.host.send(offer);
  await run.host.next();
  run.host.send({ t: "reveal", Ni: base64urlEncode(Ni) });
  expect(await run.host.next()).toEqual({ t: "abort" });
  expect(await failure).toBe("not joined");
  expect(run.anchor()).toBeUndefined();
});

test("a welcome before the person's answer is refused without returning records", async () => {
  const answer = Promise.withResolvers<boolean>();
  const run = ceremony(() => answer.promise);
  const done = runJoinCeremony(run.client, run.options);
  const failure = failureOf(done);
  run.host.send(offer);
  await run.host.next();
  run.host.send({ t: "reveal", Ni: base64urlEncode(Ni) });
  run.host.send({ t: "records", records: [] });
  expect(await failure).toContain("unexpected records");
  answer.resolve(true);
});

test("changing Ni after the commitment is refused", async () => {
  const run = ceremony();
  const done = runJoinCeremony(run.client, run.options);
  const failure = failureOf(done);
  run.host.send(offer);
  await run.host.next();
  run.host.send({ t: "reveal", Ni: base64urlEncode(h) });
  expect(await failure).toContain("commitment");
  expect(run.anchor()).toBeUndefined();
});

test.each(["client", "machine"] as const)(
  "a %s refuses an offer without commitment before sending a card",
  async (kind) => {
    const run = ceremony();
    const done = runJoinCeremony(run.client, { ...run.options, kind });
    const failure = failureOf(done);
    run.host.send({ t: "offer", mesh: "mesh", inviter: "inviter", nonce: "nonce" });
    expect(await failure).toContain("invite");
    expect(run.clientEnd.sent).toHaveLength(0);
  },
);

test("a machine without a terminal closes before its card even with yes", async () => {
  const run = ceremony();
  const done = runJoinCeremony(run.client, { ...run.options, kind: "machine", yes: true, confirm: undefined });
  const failure = failureOf(done);
  run.host.send(offer);
  expect(await failure).toContain("terminal");
  expect(run.clientEnd.sent).toHaveLength(0);
});

test("a drop between card and reveal keeps an anchor and resumes without a second card", async () => {
  const run = ceremony();
  const done = runJoinCeremony(run.client, run.options);
  const failure = failureOf(done);
  run.host.send(offer);
  await run.host.next();
  run.hostEnd.close();
  expect(await failure).toContain("closed");
  const anchor = run.anchor();
  if (anchor === undefined) throw new Error("anchor lost");
  const resumed = ceremony();
  const ready = runJoinCeremony(resumed.client, { ...run.options, resume: anchor });
  expect(await resumed.host.next()).toEqual({ t: "resume", nonce: "nonce" });
  resumed.host.send({ t: "reveal", Ni: base64urlEncode(Ni) });
  expect(await resumed.host.next()).toEqual({ t: "confirm" });
  resumed.host.send({ t: "done", mesh: "mesh" });
  expect((await ready).offer).toEqual(offer);
});

test("a refused resume deletes the anchor immediately and asks for another invite", async () => {
  const run = ceremony();
  const anchor: JoinAnchor = {
    offer,
    dialed,
    h: base64urlEncode(h),
    Nj: base64urlEncode(Ni),
    expiresAt: Date.now() + 60_000,
    confirmed: false,
  };
  await run.options.saveAnchor(anchor);
  const done = runJoinCeremony(run.client, { ...run.options, resume: anchor });
  const failure = failureOf(done);
  await run.host.next();
  run.host.send({ t: "refused", reason: "unknown join" });
  expect(await failure).toContain("Ask for a new invite");
  expect(run.anchor()).toBeUndefined();
});

test("an already confirmed resume accepts a roster offer but keeps its original anchor", async () => {
  const run = ceremony();
  const anchor: JoinAnchor = {
    offer,
    dialed,
    h: base64urlEncode(h),
    Nj: base64urlEncode(Ni),
    expiresAt: Date.now() + 60_000,
    confirmed: true,
  };
  const done = runJoinCeremony(run.client, { ...run.options, resume: anchor });
  const outcome = done.then(
    (welcome) => welcome.offer,
    (error: unknown) => String(error),
  );
  await run.host.next();
  run.host.send({ ...offer, nonce: "fresh-roster-nonce", commit: undefined });
  run.host.send({ t: "done", mesh: offer.mesh });
  expect(await outcome).toEqual(offer);
});

test("a resume refused at the authenticated session deletes its anchor immediately", async () => {
  const run = ceremony();
  const anchor: JoinAnchor = {
    offer,
    dialed,
    h: base64urlEncode(h),
    Nj: base64urlEncode(Ni),
    expiresAt: Date.now() + 60_000,
    confirmed: false,
  };
  await run.options.saveAnchor(anchor);
  const failed = failureOf(runJoinCeremony(run.client, { ...run.options, resume: anchor }));
  await run.host.next();
  run.hostEnd.close(4401, "unknown device");
  expect(await failed).toBe("Ask for a new invite");
  expect(run.anchor()).toBeUndefined();
});
