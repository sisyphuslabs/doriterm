import { afterAll, describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { join } from "node:path";
import { signalProcess } from "../testing/run-cores.ts";
import { monotonicClock } from "./clock.ts";
import { DialPolicy } from "./dial-policy.ts";
import { LineGrants } from "./line-grants.ts";
import { seededRandom } from "./testing/fake-clock.ts";
import { hostIdFor, localHost } from "./testing/hc-mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
const local = localHost();
afterAll(() => local.dispose());

const b: MemberEntry = {
  signPub: "sign-b",
  hostId: hostIdFor("b"),
  noisePub: "noise-b",
  devicePub: undefined,
  name: "b",
  hcId: "hc-b",
};
const view: MeshView = { members: [b], revoked: [] };

/** A granted line whose member says `bytes` (none: nothing) and then closes, once the host listens to it. */
function endingLink(bytes: Uint8Array | undefined): ByteLink {
  const data = new Set<(bytes: Uint8Array) => void>();
  return {
    send: () => undefined,
    onData: (listener) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onClose: (listener) => {
      queueMicrotask(() => {
        if (bytes !== undefined) for (const deliver of data) deliver(bytes);
        listener(undefined);
      });
      return () => undefined;
    },
    close: () => undefined,
  };
}

/** The real CLI as herdr runs it: stdin held open, so only the line's end can end the bridge. */
async function bridgeHeld(): Promise<{ code: number; stdout: string; reason: string }> {
  const child = Bun.spawn([process.execPath, CLI, "connect", "--mesh", "--state-dir", local.stateDir, b.hostId], {
    env: process.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, reason: stderr.trim().split("\n").at(-1) ?? "" };
  } finally {
    signalProcess(-child.pid, "SIGKILL");
  }
}

async function serving(link: ByteLink, run: () => Promise<void>): Promise<void> {
  const policy = new DialPolicy({ clock: monotonicClock, random: seededRandom(3), onDue: () => undefined });
  const lines = new LineGrants({ view: () => view, policy, dial: () => Promise.resolve(link) });
  const socket = await local.serve(lines);
  try {
    await run();
  } finally {
    socket.stop();
  }
}

// herdr reads a via that ends without its hello as "the shell line may have run under a Windows shell" unless the
// exit code is 255 (#2019): a member whose line closed before it said anything never spoke, so the bridge exits 255.
describe("a granted line's end (R-12)", () => {
  test("closed by the member before its first byte: exit 255 with the reason", async () => {
    await serving(endingLink(undefined), async () => {
      expect(await bridgeHeld()).toEqual({
        code: 255,
        stdout: "",
        reason: "doriface-host connect: the line closed before the member said anything",
      });
    });
  }, 15_000);

  test("closed by the member after it spoke: exit 0, with what it said on stdout", async () => {
    await serving(endingLink(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{}}\n')), async () => {
      expect(await bridgeHeld()).toEqual({ code: 0, stdout: '{"jsonrpc":"2.0","id":1,"result":{}}\n', reason: "" });
    });
  }, 15_000);
});
