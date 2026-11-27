import { type View } from "@doriface/mesh";
import { AuthorizeIndex, indexOf } from "../mesh/authorize-index.ts";
import { SubscriptionStore } from "../push/subscriptions.ts";
import { DeviceStore } from "./devices.ts";
import { KnownHosts } from "./known-hosts.ts";
import { type MeshFile, writeVersionOf } from "./mesh-file.ts";

/**
 * `file` with the authorize index of its generation, carrying each client's last session time over from `previous`
 * (the file it replaces), since that observation is local and never signed.
 */
export function withIndex(file: MeshFile, view: View, previous: MeshFile | undefined): MeshFile {
  const index = indexOf(file.records, view, file.generation);
  const seen = new Map(
    (previous?.meshId === file.meshId ? (previous.index?.members ?? []) : []).flatMap((member) =>
      member.kind === "client" && member.lastSessionAt !== undefined
        ? [[member.signPub, member.lastSessionAt] as const]
        : [],
    ),
  );
  const members = index.members.map((member) => {
    const lastSessionAt = member.kind === "client" ? seen.get(member.signPub) : undefined;
    return lastSessionAt === undefined ? member : { ...member, lastSessionAt };
  });
  return { ...file, version: writeVersionOf(index), index: { ...index, members } };
}

/** Removes every paired device, saved host and push subscription a write of `file` made a member's, or orphaned. */
export function cleanupAfterWrite(dir: string, file: MeshFile, log: (line: string) => void): void {
  if (file.index === undefined) return;
  const index = new AuthorizeIndex(file.index);
  const { keys, hostIds } = index.cleanup();
  for (const device of new DeviceStore(dir).removeKeysHeld(keys)) {
    log(`mesh: removed paired device "${device.name}": its key belongs to a mesh member`);
  }
  for (const hostId of new KnownHosts(dir).removeHostsHeld(hostIds)) {
    log(`mesh: removed saved host ${hostId}: the mesh reaches it now`);
  }
  try {
    new SubscriptionStore(dir).keepOwnersHeld(
      new Set([
        ...new DeviceStore(dir).list().map((device) => device.clientStaticPub),
        ...index.clients().flatMap((client) => (client.devicePub === undefined ? [] : [client.devicePub])),
      ]),
    );
  } catch (error) {
    log(`mesh: cannot prune push subscriptions: ${String(error)}`);
  }
}
