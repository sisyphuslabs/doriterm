// The e2e core's doriface-mesh document: the host's own status for its fixture mesh (one member in every state),
// written through the core's JSON-RPC the way the host publishes it. The fixture keys come from fixed seeds, so the
// names, hostIds and fingerprints in a capture are the same on every run.
import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import { MESH_STATUS_DOC } from "@doriface/protocol";

export async function seedMeshDoc(
  hc: string,
  session: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const now = new Date();
  const value = meshStatus(meshFixture(now).sources, now);
  const request = { jsonrpc: "2.0", id: 1, method: "doc.set", params: { name: MESH_STATUS_DOC, value, version: 0 } };
  const control = Bun.spawn([hc, "connect", "--session", session], { env, stdin: "pipe", stdout: "pipe" });
  control.stdin.write(`${JSON.stringify(request)}\n`);
  await control.stdin.flush();
  void control.stdin.end();
  const reply = await new Response(control.stdout).text();
  await control.exited;
  if (!reply.includes('"result"')) throw new Error(`doc.set ${MESH_STATUS_DOC} failed: ${reply.slice(0, 300)}`);
}
