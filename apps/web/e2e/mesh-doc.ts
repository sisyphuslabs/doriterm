// The e2e core's doriface-mesh document: the host's own status for its fixture mesh (one member in every state),
// written through the core's JSON-RPC the way the host publishes it. The fixture keys come from fixed seeds, so the
// names, hostIds and fingerprints in a capture are the same on every run. `bun e2e/mesh-doc.ts` prints the document as
// of now, for a spec to write again (mesh-reset.ts): the fixture is Bun-only, and specs run under Node.
import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import { MESH_STATUS_DOC } from "@doriface/protocol";

/** The document as of `now`: its open join's offer ends 8 minutes later, and the expired one ended a minute before. */
export function meshDocValue(now: Date): unknown {
  const status = meshStatus(meshFixture(now).sources, now);
  const open = status.pending[0];
  if (open === undefined) throw new Error("the mesh fixture has no pending join");
  // A join whose offer ended before the panel opened: the document can outlive its offer (design 4.3, 10.1).
  const expired = {
    ...open,
    nonce: "ZXhwaXJlZCBqb2lu",
    name: "old-runner",
    expiresAt: new Date(now.getTime() - 60_000).toISOString(),
  };
  return {
    ...status,
    pending: [...status.pending.map((join) => Object.assign({}, join, { code: "123 456" })), expired],
  };
}

export async function seedMeshDoc(
  hc: string,
  session: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const value = meshDocValue(new Date());
  const request = { jsonrpc: "2.0", id: 1, method: "doc.set", params: { name: MESH_STATUS_DOC, value, version: 0 } };
  const control = Bun.spawn([hc, "connect", "--session", session], { env, stdin: "pipe", stdout: "pipe" });
  control.stdin.write(`${JSON.stringify(request)}\n`);
  await control.stdin.flush();
  void control.stdin.end();
  const reply = await new Response(control.stdout).text();
  await control.exited;
  if (!reply.includes('"result"')) throw new Error(`doc.set ${MESH_STATUS_DOC} failed: ${reply.slice(0, 300)}`);
}

if (import.meta.main) console.log(JSON.stringify(meshDocValue(new Date())));
