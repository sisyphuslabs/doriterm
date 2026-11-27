import { AuthorizeIndex } from "../mesh/authorize-index.ts";
import { writePrivateJson } from "./files.ts";
import { withStateLock } from "./lock.ts";
import { MESH_FILE, type MeshFile, meshFileJson } from "./mesh-file.ts";

const CLIENT_SESSION_WRITE_INTERVAL_MS = 5 * 60_000;

export interface ClientSessionFile {
  readonly dir: string;
  readonly path: string;
  readonly durable: boolean;
  readonly index: () => AuthorizeIndex | undefined;
  readonly read: () => MeshFile | undefined;
  readonly log: (line: string) => void;
}

/**
 * Records when a client member last had a session here, in mesh.json's local index (never signed or gossiped): at most
 * once per client per five minutes, and never waiting for a busy state lock.
 */
export function recordClientSession(mesh: ClientSessionFile, devicePub: string, at: number): void {
  try {
    const seen = mesh.index()?.client(devicePub);
    if (
      seen === undefined ||
      (seen.lastSessionAt !== undefined && at - seen.lastSessionAt < CLIENT_SESSION_WRITE_INTERVAL_MS)
    )
      return;
    withStateLock(
      mesh.dir,
      () => {
        const file = mesh.read();
        if (file === undefined) return;
        const index = file.index;
        if (index?.generation !== file.generation) throw new Error(`${MESH_FILE}: its authorize index is stale`);
        const client = new AuthorizeIndex(index).client(devicePub);
        if (client === undefined) return;
        if (client.lastSessionAt !== undefined && at - client.lastSessionAt < CLIENT_SESSION_WRITE_INTERVAL_MS) return;
        const members = index.members.map((member) =>
          member.signPub === client.signPub ? { ...member, lastSessionAt: at } : member,
        );
        writePrivateJson(mesh.path, meshFileJson({ ...file, index: { ...index, members } }), mesh.durable);
      },
      0,
    );
  } catch (error) {
    mesh.log(`mesh: cannot record client session: ${error instanceof Error ? error.message : String(error)}`);
  }
}
