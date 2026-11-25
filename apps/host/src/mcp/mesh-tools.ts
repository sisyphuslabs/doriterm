import type { JsonObject, MeshStatus } from "@doriface/protocol";
import type { DeviceView } from "../device-surface.ts";
import type { LeaveReply, MemberRef, RenameReply, RevokeReply } from "../mesh/command-replies.ts";
import type { RenameRequest, RevokeRequest } from "../mesh/commands.ts";
import type { PendingJoin } from "../mesh/pending-joins.ts";
import type { PairingOfferView } from "../pair-offer.ts";

/**
 * What the mesh tools reach on the running host: the same calls its control socket answers `doriface-host pair`,
 * `mesh pair`, `mesh revoke`, `mesh rename`, `mesh leave` and `devices revoke` with, and a paired phone's surfaces use.
 */
export interface MeshToolDeps {
  readonly status: () => Promise<MeshStatus | undefined>;
  readonly pending: () => readonly PendingJoin[];
  readonly devices: () => readonly DeviceView[];
  /** Opens a fresh offer, replacing any pending one: for a device, or for a machine that joins the mesh. */
  readonly invite: (mesh: boolean) => Promise<PairingOfferView>;
  readonly decide: (nonce: string, approve: boolean, code?: string) => boolean;
  readonly revokeDevice: (id: string) => Promise<readonly DeviceView[]>;
  readonly revoke: (request: RevokeRequest) => Promise<RevokeReply | null>;
  readonly rename: (request: RenameRequest) => Promise<RenameReply | null>;
  readonly leavePreview: () => { readonly clients: readonly MemberRef[] };
  readonly leave: (expect?: readonly string[]) => Promise<LeaveReply | null>;
}

export interface MeshTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly run: (args: JsonObject, deps: MeshToolDeps) => Promise<unknown>;
}

/** A tool call whose arguments do not fit; the caller reads the message. */
export class MeshToolRefused extends Error {}

const NO_MESH = "this host is in no mesh";
const object = (properties: JsonObject, required: readonly string[] = []): JsonObject => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});
const text = (args: JsonObject, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value === "") throw new MeshToolRefused(`${key} must be a non-empty string`);
  return value;
};
const flag = (args: JsonObject, key: string): boolean => {
  const value = args[key];
  if (value !== undefined && typeof value !== "boolean") throw new MeshToolRefused(`${key} must be true or false`);
  return value === true;
};
const expected = (args: JsonObject): readonly string[] => {
  const value = args["expect"];
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string")) {
    throw new MeshToolRefused("with yes, expect must list the hostIds the preview named, so nothing else is written");
  }
  return value;
};
const inMesh = <T>(reply: T | null): T => {
  if (reply === null) throw new MeshToolRefused(NO_MESH);
  return reply;
};

const YES = {
  type: "boolean",
  description: "Write it. Without yes the call only answers the preview; show that to the person first.",
};
const EXPECT = {
  type: "array",
  items: { type: "string" },
  description: "With yes: the hostIds of the preview's subjects (for leave, its clients), in its order.",
};

/** The mesh tools, in the order a person meets them: look, invite, answer a join, then remove or rename. */
export const MESH_TOOLS: readonly MeshTool[] = [
  {
    name: "mesh_status",
    description:
      "This machine's mesh: its members and how each is reached, the devices paired with this machine, " +
      "and the joins waiting for an answer (each with the six digits to compare).",
    inputSchema: object({}),
    run: async (_args, deps) => ({
      mesh: (await deps.status()) ?? null,
      devices: deps.devices(),
      joins: deps.pending(),
    }),
  },
  {
    name: "mesh_invite",
    description:
      "Open an invite: for a phone or browser to pair with this machine (kind device), or for another machine to " +
      "join the mesh (kind machine). Answers a link and a code to hand to the person; it replaces any open invite. " +
      "A machine's join then waits in mesh_status for mesh_join_answer.",
    inputSchema: object({ kind: { type: "string", enum: ["device", "machine"] } }, ["kind"]),
    run: (args, deps) => {
      const kind = text(args, "kind");
      if (kind !== "device" && kind !== "machine") throw new MeshToolRefused("kind must be device or machine");
      return deps.invite(kind === "machine");
    },
  },
  {
    name: "mesh_join_answer",
    description:
      "Approve or deny a join waiting in mesh_status. Approving needs code: the six digits, which the person must " +
      "have compared with what the joining machine shows. Never approve on your own reading of the digits.",
    inputSchema: object(
      {
        join: { type: "string", description: "The join's nonce from mesh_status." },
        approve: { type: "boolean" },
        code: { type: "string", description: "The six digits of that join; needed to approve." },
      },
      ["join", "approve"],
    ),
    run: async (args, deps) => {
      const approve = args["approve"];
      if (typeof approve !== "boolean") throw new MeshToolRefused("approve must be true or false");
      const code = approve ? text(args, "code") : undefined;
      return { decided: deps.decide(text(args, "join"), approve, code) };
    },
  },
  {
    name: "mesh_revoke",
    description:
      "Remove a member from the mesh, with everything it admitted. The first call answers the preview and writes " +
      "nothing; call again with yes and expect to write it. compromised also distrusts what the member signed.",
    inputSchema: object(
      {
        member: { type: "string", description: "The member's name or hostId." },
        compromised: { type: "boolean" },
        yes: YES,
        expect: EXPECT,
      },
      ["member"],
    ),
    run: async (args, deps) => {
      const request = { member: text(args, "member"), compromised: flag(args, "compromised") };
      if (!flag(args, "yes")) return inMesh(await deps.revoke({ ...request, yes: false, preview: true }));
      return inMesh(await deps.revoke({ ...request, yes: true, expect: expected(args) }));
    },
  },
  {
    name: "mesh_rename",
    description: "Give a mesh member a new name.",
    inputSchema: object({ member: { type: "string" }, name: { type: "string" } }, ["member", "name"]),
    run: async (args, deps) => inMesh(await deps.rename({ member: text(args, "member"), name: text(args, "name") })),
  },
  {
    name: "mesh_leave",
    description:
      "Take this machine out of its mesh; the clients it admitted leave with it. The first call answers who leaves " +
      "and writes nothing; call again with yes and expect to do it. This session ends with it.",
    inputSchema: object({ yes: YES, expect: EXPECT }),
    run: async (args, deps) => {
      if (!flag(args, "yes")) return deps.leavePreview();
      return inMesh(await deps.leave(expected(args)));
    },
  },
  {
    name: "mesh_device_revoke",
    description:
      "Unpair a phone, browser or assistant from this machine by its id from mesh_status; its sessions close at " +
      "once. Revoking the device this session runs on ends this session.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    run: async (args, deps) => ({ devices: await deps.revokeDevice(text(args, "id")) }),
  },
];
