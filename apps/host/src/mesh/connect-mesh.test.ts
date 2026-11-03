import { afterAll, describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { join } from "node:path";
import { monotonicClock } from "./clock.ts";
import { DialPolicy } from "./dial-policy.ts";
import { MeshLines } from "./mesh-lines.ts";
import { seededRandom } from "./testing/fake-clock.ts";
import { hostIdFor, localHost } from "./testing/hc-mesh.ts";
import type { MeshMember, MeshView } from "./upstream.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
const local = localHost();
afterAll(() => local.dispose());

const member = (name: string): MeshMember => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  name,
  hcId: `hc-${name}`,
});
const b = member("b");
const view: MeshView = { members: [member("a"), b], overCap: [], revoked: [] };

function fakeLink(): ByteLink & { readonly closes: (number | undefined)[] } {
  const closes: (number | undefined)[] = [];
  const listeners = new Set<(error: Error | undefined) => void>();
  return {
    closes,
    send: () => undefined,
    onData: () => () => undefined,
    onClose: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: (code) => {
      closes.push(code);
      for (const listener of listeners) listener(undefined);
    },
  };
}

async function bridge(...args: readonly string[]): Promise<{ code: number; reason: string }> {
  const child = Bun.spawn([process.execPath, CLI, "connect", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, reason: stderr.trim().split("\n").at(-1) ?? "" };
}

describe("connect --mesh refusals (R-12)", () => {
  test("no host running: exit 1 with one reason line", async () => {
    expect(await bridge("--mesh", "--state-dir", local.stateDir, b.hostId)).toEqual({
      code: 1,
      reason: "doriface-host connect: doriface-host is not running",
    });
  });

  test("not a member, offline-gated, out of budget: exit 1 with the reason, never 127, and no dial", async () => {
    const policy = new DialPolicy({ clock: monotonicClock, random: seededRandom(1), onDue: () => undefined });
    const dialed: string[] = [];
    const lines = new MeshLines({
      view: () => view,
      policy,
      dial: (target) => {
        dialed.push(target.name);
        return Promise.resolve(fakeLink());
      },
      waitMs: 50,
    });
    const socket = await local.serve(lines);
    try {
      const outsider = await bridge("--mesh", "--state-dir", local.stateDir, hostIdFor("zed"));
      expect(outsider).toEqual({ code: 1, reason: "doriface-host connect: not a member of this mesh" });
      policy.report(b.signPub, 4404);
      const offline = await bridge("--mesh", "--state-dir", local.stateDir, b.hostId);
      expect(offline.code).toBe(1);
      expect(offline.reason).toMatch(/^doriface-host connect: b is offline \(4404 ×1\); next try in (29|30) s$/);
      policy.report(b.signPub, "connected");
      await Promise.all(Array.from({ length: 12 }, (_, i) => policy.acquire(`m${i}`, "push")));
      const budget = await bridge("--mesh", "--state-dir", local.stateDir, b.hostId);
      expect(budget).toEqual({ code: 1, reason: "doriface-host connect: waiting for the dial budget" });
      expect(dialed).toEqual([]);
    } finally {
      socket.stop();
    }
  });

  test("--mesh takes a member's hostId only: --replace and pairing links are usage errors (exit 1)", async () => {
    const replace = await bridge("--mesh", "--replace", "--state-dir", local.stateDir, b.hostId);
    expect(replace).toEqual({
      code: 1,
      reason: "doriface-host connect: --mesh takes no --replace: a member's key comes from the mesh",
    });
    const link = await bridge("--mesh", "--state-dir", local.stateDir, "ABCD-EFGH");
    expect(link.code).toBe(1);
  });
});

describe("revocation closes outbound lines (R-13)", () => {
  test("a granted line is registered under the member, and a view without it closes the line with 4401", async () => {
    const policy = new DialPolicy({ clock: monotonicClock, random: seededRandom(2), onDue: () => undefined });
    const link = fakeLink();
    const lines = new MeshLines({ view: () => view, policy, dial: () => Promise.resolve(link) });
    expect((await lines.grant(b.hostId)).ok).toBe(true);
    lines.closeRevoked({ members: [member("a")], overCap: [], revoked: [b.signPub] });
    expect(link.closes).toEqual([4401]);
  });
});
