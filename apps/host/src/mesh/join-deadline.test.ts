import { CloseCode, generateX25519 } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { failure, inviteDeps, joinerContext, removeSides, runJoin, side } from "../testing/join-harness.ts";
import { serveJoin } from "./invite.ts";
import { runJoiner } from "./join.ts";
import { INVITER_EXPECTS, JOINER_EXPECTS, MeshLines } from "./lines.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

describe("a join dies with its offer (section 10.1)", () => {
  test("a joiner that sends no card before the offer expires is refused with 4401", async () => {
    const a = side("alpha");
    const [inviterEnd] = memoryLinkPair();
    const deps = inviteDeps(a, new PendingJoins(), Date.now() + 30);
    const invited = failure(serveJoin(new MeshLines(inviterEnd, INVITER_EXPECTS), generateX25519().publicKey, deps));
    expect(await invited).toBe("the offer expired before the card arrived");
    expect(inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
  });

  test("an inviting member that never welcomes the joiner fails the join at its deadline, storing nothing", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const [, joinerEnd] = memoryLinkPair();
    const ctx = { ...joinerContext(b, a), deadline: Date.now() + 30 };
    const joined = failure(runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), ctx));
    expect(await joined).toBe("Ask for a new invite");
    expect(joinerEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(b.mesh.read()).toBeUndefined();
  });
});

describe("founding on the first join", () => {
  test("a host whose own name is not a valid mesh name founds nothing and refuses the join", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const deps = { ...inviteDeps(a), own: async () => ({ name: "Not A Mesh Name", hcId: "core" }) };
    const run = runJoin(deps, joinerContext(b, a), b.m.identity.noise.publicKey);
    expect(await failure(run.invited)).toBe('this host\'s name "Not A Mesh Name" is not a valid mesh name');
    expect(a.mesh.read()).toBeUndefined();
  });
});
