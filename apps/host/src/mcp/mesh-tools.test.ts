import { expect, test } from "bun:test";
import type { RevokeRequest } from "../mesh/commands.ts";
import type { PushLink } from "../push/push-stream.ts";
import { MESH_TOOLS, type MeshToolDeps } from "./mesh-tools.ts";
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
  let next = 0;
  const call = async (name: string, args: object = {}) => {
    const id = ++next;
    const answered = new Promise<void>((resolve) => waiters.push(resolve));
    const line = { jsonrpc: "2.0", id, method: "tools/call", params: { _meta: META, name, arguments: args } };
    onData?.(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
    await answered;
    const reply = replies.find((one) => one.id === id);
    return { isError: reply?.result.isError, content: reply?.result.structuredContent };
  };
  return { acts, call };
}

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
  expect(await stateless.call("doriterm_call", { tool: "mesh_device_revoke", arguments: { id: "d1" } })).toMatchObject({
    isError: true,
  });
  expect(stateless.acts).toEqual([]);
});

test("mesh tools are reached through doriterm_call and found by doriterm_tools, all under the mesh group", async () => {
  const s = session();
  expect(await s.call("doriterm_call", { tool: "mesh_device_revoke", arguments: { id: "d1" } })).toEqual({
    isError: false,
    content: { devices: [] },
  });
  expect(s.acts).toEqual([{ revokeDevice: "d1" }]);
  const found = await s.call("doriterm_tools", { query: "mesh_" });
  expect(JSON.stringify(found.content)).toContain('"name":"mesh_join_answer"');
  expect(MESH_TOOLS.every((tool) => tool.name.startsWith("mesh_"))).toBe(true);
});
