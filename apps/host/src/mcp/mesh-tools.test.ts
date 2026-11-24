import { expect, test } from "bun:test";
import type { RevokeRequest } from "../mesh/commands.ts";
import type { PushLink } from "../push/push-stream.ts";
import { HOST_TOOLS, MESH_TOOLS, type MeshToolDeps } from "./mesh-tools.ts";
import { serveMcpLines } from "./serve.ts";

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const JOIN = {
  nonce: "n1",
  name: "laptop",
  hostId: "h-laptop",
  fingerprint: "AAAA BBBB",
  noisePub: "pub",
  kind: "machine" as const,
  expiresAt: 9e15,
  code: "123456",
  joinerConfirmed: true,
};
const REF = { hostId: "h-laptop", name: "laptop" };

/** A session on a host whose mesh records every call; a reply is there as soon as the tool's promise settles. */
function session(over: Partial<MeshToolDeps> = {}, withMesh = true) {
  const acts: unknown[] = [];
  const replies: { id: number; result: { isError: boolean; structuredContent: unknown } }[] = [];
  const waiters: (() => void)[] = [];
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  const link: PushLink = {
    send: (bytes) => {
      replies.push(JSON.parse(new TextDecoder().decode(bytes)));
      waiters.shift()?.();
    },
    onData: (handler) => {
      onData = handler;
    },
    onClose: () => {},
    close: () => {},
  };
  const mesh: MeshToolDeps = {
    host: { version: "0.1.25", hostId: "h-studio", relay: "https://relay.example" },
    status: async () => undefined,
    pending: () => [JOIN],
    devices: () => [{ name: "phone", id: "d1", pairedAt: "2026-11-24T00:00:00Z" }],
    invite: async (machine) => {
      acts.push({ invite: machine });
      throw new Error("the relay holds no slot");
    },
    decide: (nonce, approve, code) => {
      acts.push({ decide: nonce, approve, code });
      return true;
    },
    revokeDevice: async (id) => {
      acts.push({ revokeDevice: id });
      return [];
    },
    revoke: async (request: RevokeRequest) => {
      acts.push({ revoke: request });
      const written = request.preview !== true;
      return { written, target: REF, subjects: [REF], clients: [], reason: "revoke", lines: [], needsYes: true };
    },
    rename: async () => null,
    leavePreview: () => ({ clients: [REF] }),
    leave: async (clients) => {
      acts.push({ leave: clients });
      return { signed: true, members: [], confirmed: [], revokeCommand: null, machinesKept: null };
    },
    ...over,
  };
  serveMcpLines(link, { hostVersion: "0.0.0-test", mesh: withMesh ? mesh : undefined });
  const call = async (name: string, args: object = {}) => {
    const tool = [...HOST_TOOLS, ...MESH_TOOLS].find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    try {
      if (!withMesh) throw new Error("this host keeps no state, so it has no mesh or devices");
      return { isError: false, content: await tool.run({ ...args }, mesh) };
    } catch (error) {
      return {
        isError: true,
        content: { kind: "refused", message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
  let next = 0;
  const run = async (args: readonly string[]) => {
    const id = ++next;
    const answered = new Promise<void>((resolve) => waiters.push(resolve));
    const line = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _meta: META, name: "doriterm", arguments: { args } },
    };
    onData?.(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    await answered;
    const reply = replies.find((one) => one.id === id);
    return { isError: reply?.result.isError, content: reply?.result.structuredContent };
  };
  return { acts, call, run };
}

test("host_status answers this host's version, id, relay and the devices paired with it", async () => {
  const s = session();
  expect(await s.call("host_status")).toEqual({
    isError: false,
    content: {
      version: "0.1.25",
      hostId: "h-studio",
      relay: "https://relay.example",
      mcp: "on",
      devices: [{ name: "phone", id: "d1", pairedAt: "2026-11-24T00:00:00Z" }],
    },
  });
});

test("mesh_status answers the members, the paired devices and the joins that wait, with their digits", async () => {
  const s = session();
  const { isError, content } = await s.call("mesh_status");
  expect(isError).toBe(false);
  expect(content).toEqual({
    mesh: null,
    devices: [{ name: "phone", id: "d1", pairedAt: "2026-11-24T00:00:00Z" }],
    joins: [JOIN],
  });
});

test("a join is approved only with its digits: without them nothing reaches the host, and a deny needs none", async () => {
  const s = session();
  expect(await s.call("mesh_join_answer", { join: "n1", approve: true })).toEqual({
    isError: true,
    content: { kind: "refused", message: "code must be a non-empty string" },
  });
  expect(await s.call("mesh_join_answer", { join: "n1", approve: "yes", code: "123456" })).toMatchObject({
    isError: true,
  });
  expect(s.acts).toEqual([]);
  expect(await s.call("mesh_join_answer", { join: "n1", approve: true, code: "123456" })).toEqual({
    isError: false,
    content: { decided: true },
  });
  expect(await s.call("mesh_join_answer", { join: "n1", approve: false })).toMatchObject({ isError: false });
  expect(s.acts).toEqual([
    { decide: "n1", approve: true, code: "123456" },
    { decide: "n1", approve: false, code: undefined },
  ]);
});

test("the host's own refusal of a join answer comes back in its words as a tool error", async () => {
  const s = session({
    decide: () => {
      throw new Error("the approval code does not match this join");
    },
  });
  expect(await s.call("mesh_join_answer", { join: "n1", approve: true, code: "000000" })).toEqual({
    isError: true,
    content: { kind: "refused", message: "the approval code does not match this join" },
  });
});

test("a revoke writes nothing until yes names the subjects the preview showed", async () => {
  const s = session();
  const preview = await s.call("mesh_revoke", { member: "laptop" });
  expect(preview).toMatchObject({ isError: false, content: { written: false, subjects: [REF] } });
  expect(await s.call("mesh_revoke", { member: "laptop", yes: true })).toMatchObject({ isError: true });
  expect(await s.call("mesh_revoke", { member: "laptop", yes: "true", expect: ["h-laptop"] })).toMatchObject({
    isError: true,
  });
  expect(s.acts).toEqual([{ revoke: { member: "laptop", compromised: false, yes: false, preview: true } }]);
  const written = await s.call("mesh_revoke", { member: "laptop", yes: true, expect: ["h-laptop"] });
  expect(written).toMatchObject({ isError: false, content: { written: true } });
  expect(s.acts[1]).toEqual({ revoke: { member: "laptop", compromised: false, yes: true, expect: ["h-laptop"] } });
});

test("leave answers who leaves first, and leaves only with yes and that list", async () => {
  const s = session();
  expect(await s.call("mesh_leave")).toEqual({ isError: false, content: { clients: [REF] } });
  expect(await s.call("mesh_leave", { yes: true })).toMatchObject({ isError: true });
  expect(s.acts).toEqual([]);
  expect(await s.call("mesh_leave", { yes: true, expect: ["h-laptop"] })).toMatchObject({ isError: false });
  expect(s.acts).toEqual([{ leave: ["h-laptop"] }]);
});

test("an invite that cannot open, a host in no mesh and a host without state each answer a tool error", async () => {
  const s = session();
  expect(await s.call("mesh_invite", { kind: "machine" })).toEqual({
    isError: true,
    content: { kind: "refused", message: "the relay holds no slot" },
  });
  expect(await s.call("mesh_invite", { kind: "everyone" })).toMatchObject({ isError: true });
  expect(s.acts).toEqual([{ invite: true }]);
  expect(await s.call("mesh_rename", { member: "laptop", name: "desk" })).toEqual({
    isError: true,
    content: { kind: "refused", message: "this host is in no mesh" },
  });
  const stateless = session({}, false);
  expect(await stateless.call("mesh_status")).toMatchObject({ isError: true });
  expect(await stateless.run(["devices", "revoke", "d1"])).toMatchObject({ isError: true });
  expect(stateless.acts).toEqual([]);
});

test("the mesh, the devices and the host's status are reached through the one tool, with CLI words", async () => {
  const s = session();
  expect(await s.run(["devices", "revoke", "d1"])).toEqual({ isError: false, content: { devices: [] } });
  expect(s.acts).toEqual([{ revokeDevice: "d1" }]);
  expect(await s.run(["mesh", "status"])).toMatchObject({ isError: false, content: { joins: [JOIN] } });
  expect(await s.run(["host", "status"])).toMatchObject({ isError: false, content: { hostId: "h-studio", mcp: "on" } });
  expect(await s.run(["mesh", "join", "n1", "approve", "123456"])).toMatchObject({ isError: false });
  expect(s.acts.at(-1)).toEqual({ decide: "n1", approve: true, code: "123456" });
  expect(MESH_TOOLS.every((tool) => tool.name.startsWith("mesh_"))).toBe(true);
});
