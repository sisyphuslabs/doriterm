import { base64urlEncode, CloseCode, generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord } from "@doriface/mesh";
import { INVITER_EXPECTS, meshInviteOf, MeshLines } from "@doriface/mesh/join";
import { afterEach, describe, expect, test } from "bun:test";
import { type InviteDeps, serveJoin } from "../../../host/src/mesh/invite.ts";
import { PendingJoins } from "../../../host/src/mesh/pending-joins.ts";
import { failure, inviteDeps, removeSides, type Side, side } from "../../../host/src/testing/join-harness.ts";
import { memoryStore } from "../storage/idb.ts";
import { type BrowserJoinerDeps, joinOnLink } from "./joiner.ts";
import { MembershipStore, reachableTargets } from "./membership.ts";

afterEach(removeSides);

const autoJoins = (): PendingJoins => {
  const pending = new PendingJoins();
  void pending.next().then((join) => pending.decide(join.nonce, true, join.code));
  return pending;
};

/** The inviting member with its cohort ready for a client admission, as a host whose sync runs answers. */
const readyInviter = (inviter: Side, pending: PendingJoins): InviteDeps => ({
  ...inviteDeps(inviter, pending),
  formatReady: () => true,
});

function browser(membership = new MembershipStore(memoryStore())): BrowserJoinerDeps {
  return {
    invite: meshInviteOf({ kind: "link", mesh: true }),
    sign: generateEd25519(),
    device: rawStaticKey(generateX25519()),
    name: "chrome-on-macos",
    membership,
    storage: memoryStore(),
    handshakeHash: new Uint8Array(32),
    confirm: async () => true,
  };
}

function run(inviter: Side, deps: InviteDeps, joiner: BrowserJoinerDeps) {
  const [inviterEnd, joinerEnd] = memoryLinkPair();
  const invited = serveJoin(new MeshLines(inviterEnd, INVITER_EXPECTS), joiner.device.publicKey, deps);
  const dialed = {
    hostId: inviter.m.identity.hostId,
    hostKey: inviter.m.identity.noise.publicKey,
    relayUrl: "wss://r",
  };
  const joined = joinOnLink(joinerEnd, dialed, joiner);
  invited.catch(() => undefined);
  joined.catch(() => undefined);
  return { inviterEnd, joinerEnd, invited, joined };
}

describe("a browser's join, approved", () => {
  test("stores the inviter's records as its membership and is a client member there, reached by its device key", async () => {
    const a = side("alpha");
    const joiner = browser();
    const { invited, joined, inviterEnd, joinerEnd } = run(a, readyInviter(a, autoJoins()), joiner);
    const result = await joined;
    await invited;
    const stored = await joiner.membership.read();
    expect(result.meshId).toBe(a.mesh.read()?.meshId ?? "");
    expect(stored?.records).toEqual(a.mesh.read()?.records ?? []);
    expect(stored?.signPub).toBe(base64urlEncode(joiner.sign.publicKey));
    expect(stored?.inviter).toEqual({
      hostId: a.m.identity.hostId,
      hostKey: base64urlEncode(a.m.identity.noise.publicKey),
    });
    const devicePub = base64urlEncode(joiner.device.publicKey);
    const index = a.mesh.authorizeIndex();
    expect(index?.client(devicePub)?.kind).toBe("client");
    expect(index?.client(devicePub)?.name).toBe("chrome-on-macos");
    expect(index?.member(devicePub)).toBeUndefined();
    expect([inviterEnd.closeCode, joinerEnd.closeCode]).toEqual([undefined, 1000]);
  });

  test("the member list it derives names itself by its signing key, and the targets are the machines alone", async () => {
    const a = side("alpha");
    const joiner = browser();
    const { joined } = run(a, readyInviter(a, autoJoins()), joiner);
    const result = await joined;
    const self = result.members.find((member) => member.signPub === base64urlEncode(joiner.sign.publicKey));
    expect(self?.kind).toBe("client");
    expect(self?.hostId).toBe(hostIdOf(joiner.sign.publicKey));
    expect(reachableTargets(result.members)).toEqual([
      {
        hostId: a.m.identity.hostId,
        hostName: "alpha",
        hostKey: base64urlEncode(a.m.identity.noise.publicKey),
        directUrl: "",
      },
    ]);
  });
});

describe("a browser's join, refused", () => {
  test("the inviting member asks about a client, and a denial stores nothing and closes 4401", async () => {
    const a = side("alpha");
    const pending = new PendingJoins();
    const joiner = browser();
    const { joined, inviterEnd } = run(a, readyInviter(a, pending), joiner);
    const asked = await pending.next();
    expect([asked.kind, asked.name, asked.hostId]).toEqual([
      "client",
      "chrome-on-macos",
      hostIdOf(joiner.sign.publicKey),
    ]);
    pending.decide(asked.nonce, false);
    expect(await failure(joined)).toContain("the join was denied on the inviting member");
    expect(await joiner.membership.read()).toBeUndefined();
    expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect((a.mesh.read()?.records ?? []).map((record) => parseRecord(record)?.type)).toEqual(["found"]);
  });

  test("an inviter whose cohort does not read the client format refuses, and the browser stores nothing", async () => {
    const a = side("alpha");
    const joiner = browser();
    const { joined } = run(a, inviteDeps(a, autoJoins()), joiner);
    expect(await failure(joined)).toContain("a client can join once every machine in this mesh reads the new format");
    expect(await joiner.membership.read()).toBeUndefined();
  });

  test("a membership of another mesh adopted meanwhile wins, and the join fails after the welcome", async () => {
    const a = side("alpha");
    const membership = new MembershipStore(memoryStore());
    const other = {
      meshId: "other-mesh",
      records: [],
      signPub: "x",
      inviter: { hostId: "h", hostKey: "k" },
      relayUrl: "wss://r",
      joinedAt: "2026-11-08T00:00:00.000Z",
    };
    const pending = new PendingJoins();
    const { joined } = run(a, readyInviter(a, pending), browser(membership));
    const asked = await pending.next();
    await membership.adopt(other);
    pending.decide(asked.nonce, true, asked.code);
    expect(await failure(joined)).toBe("a mesh appeared on this member meanwhile");
    expect((await membership.read())?.meshId).toBe("other-mesh");
  });
});
