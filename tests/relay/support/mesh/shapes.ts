import { untilFullMesh } from "./echo.ts";
import { untilGone } from "./gone.ts";
import { Chain, type Actor } from "./records.ts";
import type { Ctx } from "./shape-ctx.ts";
import type { SignedRecord } from "./status.ts";

export interface Gated {
  readonly id: string;
  readonly gated: string;
}

/** One E-BACKDATE shape (design section 3.6): real hosts reach a state, then a revoked key's records are injected. */
export interface Runnable {
  readonly id: string;
  readonly founder: string;
  readonly names: readonly string[];
  setup(ctx: Ctx): Promise<void>;
  /** The attacker's records in causal order, signed with keys the harness took from the revoked host. */
  attack(ctx: Ctx): Promise<readonly SignedRecord[]>;
  /** Hosts that receive the records, and judge them. Each gets them through another honest host's session. */
  readonly honest: readonly string[];
  /** The view every honest host must hold afterwards; empty is the fail-closed outcome. */
  readonly members: readonly string[];
}

export type Shape = Gated | Runnable;

const NO_CARRIER =
  "N = 2 leaves no member to carry the revoked key's records into a session; the design's channel is the revoked host's answer on the push session (5.3), which needs PR 5's responder seam";

/** Collects records in the order they are written, across several signers. */
class Script {
  readonly out: SignedRecord[] = [];

  step(chain: Chain, make: () => string): string {
    const hash = make();
    const written = chain.written.at(-1);
    if (written !== undefined) this.out.push(written);
    return hash;
  }
}

const chainOf = (ctx: Ctx, by: Actor, from: { readonly n: number; readonly hash: string }): Chain =>
  new Chain(ctx.kit, ctx.meshId, by, from);

const gone = (ctx: Ctx, revoker: string, who: string, watchers: readonly string[]): Promise<void> =>
  ctx.mesh
    .host(revoker)
    .cli("mesh", "revoke", who, "--yes")
    .then(() => untilGone(ctx.mesh, watchers, [who]));

export const R2: Runnable = {
  id: "R2",
  founder: "a",
  names: ["a", "b", "c"],
  honest: ["a", "b"],
  members: ["a", "b"],
  async setup({ mesh, ...ctx }) {
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await untilFullMesh(mesh, ["a", "b", "c"]);
    await gone({ mesh, ...ctx }, "b", "c", ["a", "b"]);
  },
  async attack(ctx) {
    const [x, a, b] = await Promise.all([ctx.actor("c"), ctx.actor("a"), ctx.actor("b")]);
    const script = new Script();
    const chain = chainOf(ctx, x, ctx.last(x, "a"));
    script.step(chain, () => chain.revoke(b));
    script.step(chain, () => chain.revoke(a));
    script.step(chain, () => chain.admit(ctx.mint("z")));
    return script.out;
  },
};

export const P2: Runnable = {
  id: "P2",
  founder: "a",
  names: ["a", "b", "c", "d"],
  honest: ["a", "c", "d"],
  members: [],
  async setup(ctx) {
    await ctx.mesh.join("a", "b");
    await ctx.actor("b");
    await gone(ctx, "a", "b", ["a"]);
    await ctx.mesh.join("a", "c");
    await ctx.mesh.join("a", "d");
    await untilFullMesh(ctx.mesh, ["a", "c", "d"]);
  },
  async attack(ctx) {
    const [b, a] = await Promise.all([ctx.actor("b"), ctx.actor("a")]);
    const script = new Script();
    const chain = chainOf(ctx, b, ctx.last(b, "a"));
    script.step(chain, () => chain.admit(ctx.mint("z")));
    script.step(chain, () => chain.revoke(a));
    return script.out;
  },
};

async function honest3(ctx: Ctx): Promise<void> {
  await ctx.mesh.join("a", "b");
  await ctx.mesh.join("a", "c");
  await ctx.mesh.join("c", "d");
  await untilFullMesh(ctx.mesh, ["a", "b", "c", "d"]);
  await gone(ctx, "b", "d", ["a", "b", "c"]);
}

export const P3: Runnable = {
  id: "P3",
  founder: "a",
  names: ["a", "b", "c", "d"],
  honest: ["a", "b", "c"],
  members: ["a", "b", "c"],
  setup: honest3,
  async attack(ctx) {
    const [bad, a, g, c] = await Promise.all([ctx.actor("d"), ctx.actor("a"), ctx.actor("b"), ctx.actor("c")]);
    const [z0, z1] = [ctx.mint("z0"), ctx.mint("z1")];
    const script = new Script();
    const chainB = chainOf(ctx, bad, ctx.last(bad, "a"));
    const hZ0 = script.step(chainB, () => chainB.admit(z0));
    const chainZ0 = chainOf(ctx, z0, { n: 0, hash: hZ0 });
    const hZ1 = script.step(chainZ0, () => chainZ0.admit(z1));
    const chainZ1 = chainOf(ctx, z1, { n: 0, hash: hZ1 });
    script.step(chainZ1, () => chainZ1.revoke(a, c));
    script.step(chainB, () => chainB.revoke(g));
    script.step(chainZ1, () => chainZ1.ack());
    return script.out;
  },
};

export const P4: Runnable = {
  id: "P4",
  founder: "a",
  names: ["a", "b", "c", "d"],
  honest: ["a", "b", "c"],
  members: ["a", "b", "c"],
  setup: honest3,
  async attack(ctx) {
    const [bad, a, g, c] = await Promise.all([ctx.actor("d"), ctx.actor("a"), ctx.actor("b"), ctx.actor("c")]);
    const z0 = ctx.mint("z0");
    const script = new Script();
    const chainB = chainOf(ctx, bad, ctx.last(bad, "a"));
    const hZ0 = script.step(chainB, () => chainB.admit(z0));
    script.step(chainB, () => chainB.revoke(a, c));
    script.step(chainB, () => chainB.ack());
    const chainZ0 = chainOf(ctx, z0, { n: 0, hash: hZ0 });
    script.step(chainZ0, () => chainZ0.revoke(g));
    script.step(chainB, () => chainB.revoke(a, g, c));
    return script.out;
  },
};

export const P8: Runnable = {
  id: "P8",
  founder: "a",
  names: ["a", "b", "c"],
  honest: ["a", "c"],
  members: [],
  async setup(ctx) {
    await ctx.mesh.join("a", "b");
    await ctx.actor("b");
    await ctx.mesh.host("b").stop();
    await ctx.mesh.join("a", "c");
    await gone(ctx, "a", "b", ["a", "c"]);
  },
  async attack(ctx) {
    const [bad, g, a] = await Promise.all([ctx.actor("b"), ctx.actor("a"), ctx.actor("c")]);
    const z0 = ctx.mint("z0");
    const script = new Script();
    const chainB = chainOf(ctx, bad, ctx.last(bad, "a"));
    const hZ0 = script.step(chainB, () => chainB.admit(z0));
    script.step(chainB, () => chainB.revoke(g));
    const chainZ0 = chainOf(ctx, z0, { n: 0, hash: hZ0 });
    script.step(chainZ0, () => chainZ0.revoke(a));
    script.step(chainZ0, () => chainZ0.ack());
    return script.out;
  },
};

export const SHAPES: readonly Shape[] = [
  R2,
  { id: "P1", gated: NO_CARRIER },
  { id: "P1b", gated: NO_CARRIER },
  P2,
  P3,
  P4,
  P8,
  { id: "P13", gated: NO_CARRIER },
];
