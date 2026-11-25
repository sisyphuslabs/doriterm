import { MCP_EXCLUDED_METHODS, MCP_TOOLS } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnv } from "./hc-cli.ts";
import { FILE_TOOLS } from "./file-tools.ts";
import { HOST_TOOLS, MESH_TOOLS } from "./mesh-tools.ts";
import { type Plan, planCall } from "./one-tool.ts";

const CONTEXT = { stateDirs: ["/home/me/.local/state/doriface-host"], home: "/home/me", cwd: "/home/me/project" };
const plan = (args: readonly string[]): Plan => planCall(args, CONTEXT);
const scope = (args: readonly string[]): unknown => Reflect.get(plan(args), "scope");
const kind = (args: readonly string[]): string => {
  const planned = plan(args);
  if (planned.kind === "mesh" || planned.kind === "file") return `${planned.kind}:${planned.tool.name}`;
  if (planned.kind === "rpc") return `rpc:${planned.method}`;
  return planned.kind;
};

/** Every tool the session listed before #2789, and the one-tool command that reaches the same behaviour now. */
const FORMER: Readonly<Record<string, readonly string[]>> = {
  server_status: ["server", "status"],
  terminal_run: ["run", "--bg", "claude"],
  templates_list: ["templates"],
  terminal_list: ["ls"],
  terminal_get: ["get", "t1"],
  terminal_kill: ["kill", "t1"],
  terminal_rm: ["rm", "t1"],
  terminal_keep: ["keep", "t1"],
  terminal_label: ["label", "t1", "k=v"],
  terminal_read: ["read", "t1"],
  terminal_send: ["send", "t1", "hi"],
  terminal_wait: ["wait", "t1"],
  terminal_keys: ["keys", "t1", "enter"],
  terminal_interrupt: ["interrupt", "t1"],
  terminal_put: ["put", "t1", "notes.txt"],
  machine_exec: ["exec", "uname -a"],
  file_read: ["file", "read", "/etc/hostname"],
  file_write: ["file", "write", "/tmp/x"],
  file_edit: ["file", "edit", "/tmp/x", "--old", "a", "--new", "b"],
  doc_get: ["doc", "get", "layout"],
  doc_set: ["doc", "set", "layout", "{}"],
  machine_add: ["machine", "add", "box", "--name", "box"],
  machine_list: ["machine", "ls"],
  machine_connect: ["machine", "connect", "box"],
  machine_rename: ["machine", "rename", "a", "b"],
  file_list: ["file", "list", "/tmp"],
  file_stat: ["file", "stat", "/tmp"],
  file_glob: ["file", "glob", "/tmp", "*.ts"],
  file_grep: ["file", "grep", "/tmp", "needle"],
  file_read_bytes: ["file", "bytes", "/tmp/a.bin", "--length", "10"],
  host_status: ["host", "status"],
  mesh_status: ["mesh", "status"],
  mesh_invite: ["mesh", "invite", "device"],
  mesh_join_answer: ["mesh", "join", "n1", "approve", "123456"],
  mesh_revoke: ["mesh", "revoke", "laptop", "--yes", "--expect", "h1"],
  mesh_rename: ["mesh", "rename", "laptop", "studio"],
  mesh_leave: ["mesh", "leave"],
  mesh_device_revoke: ["devices", "revoke", "d1"],
};

test("every tool listed before the change is reachable through the one tool", () => {
  const former = [...MCP_TOOLS, ...FILE_TOOLS, ...HOST_TOOLS, ...MESH_TOOLS].map((tool) => tool.name);
  expect(former.filter((name) => FORMER[name] === undefined)).toEqual([]);
  for (const [name, args] of Object.entries(FORMER)) {
    expect([name, plan(args).kind === "refused" ? plan(args) : "ok"]).toEqual([name, "ok"]);
  }
  expect(kind(FORMER["mesh_revoke"] ?? [])).toBe("mesh:mesh_revoke");
  expect(kind(FORMER["file_read_bytes"] ?? [])).toBe("file:file_read_bytes");
  expect(kind(FORMER["doc_set"] ?? [])).toBe("rpc:doc.set");
  expect(kind(FORMER["terminal_send"] ?? [])).toBe("hc");
});

test("what an MCP session must never do is refused, the methods left out by ruling included", () => {
  const refused = [
    [],
    ["attach"],
    ["connect"],
    ["events"],
    ["update"],
    ["server", "stop"],
    ["server", "restart"],
    ["machine", "rm", "x"],
    ["machine", "login", "x"],
    ["nonsense"],
  ];
  for (const args of refused) expect([args, plan(args).kind]).toEqual([args, "refused"]);
  expect(MCP_EXCLUDED_METHODS).toEqual(expect.arrayContaining(["server.stop", "server.restart", "machine.rm"]));
});

test("each verb needs its scope: looking is read, changing is act, the mesh is mesh", () => {
  expect(["ls", "read", "wait", "templates"].map((verb) => scope([verb, "t1"]))).toEqual([
    "read",
    "read",
    "read",
    "read",
  ]);
  expect(
    [["file", "read", "/tmp/a"], ["file", "list", "/tmp"], ["host", "status"], ["mesh", "status"], ["skill"]].map(
      scope,
    ),
  ).toEqual(["read", "read", "read", "read", "read"]);
  expect(
    [
      ["run", "ls"],
      ["exec", "ls"],
      ["send", "t1", "x"],
      ["file", "write", "/tmp/a"],
      ["doc", "set", "a", "b"],
    ].map(scope),
  ).toEqual(["act", "act", "act", "act", "act"]);
  expect(
    [
      ["mesh", "invite", "device"],
      ["devices", "revoke", "d1"],
      ["mesh", "leave"],
    ].map(scope),
  ).toEqual(["mesh", "mesh", "mesh"]);
});

test("no file verb reaches the host's private state: absolute, ~, relative and .. paths alike, put included", () => {
  const inside = [
    ["file", "read", "/home/me/.local/state/doriface-host/host-key.json"],
    ["file", "read", "~/.local/state/doriface-host/devices.json"],
    ["file", "read", "../.local/state/doriface-host/mesh.json"],
    ["file", "write", "/home/me/.local/state/doriface-host/../doriface-host/devices.json"],
    ["file", "bytes", "/home/me/.local/state/doriface-host"],
    ["file", "list", "/home/me/.local/state/doriface-host"],
    ["put", "t1", "/home/me/.local/state/doriface-host/x"],
  ];
  for (const args of inside)
    expect([args, plan(args)]).toEqual([args, { kind: "refused", message: "that path is the host's private state" }]);
  expect(plan(["file", "read", "/home/me/.local/state/other-app/x"]).kind).toBe("hc");
});

test("an hc command runs on the host's own session and never as the terminal the host itself runs in", () => {
  const env = cliEnv({
    hc: "hc",
    session: "main",
    env: { PATH: "/bin", HC_TERMINAL_ID: "t4", HC_SESSION: "other", HOME: "/home/me" },
  });
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/me", HC_SESSION: "main" });
});

test("a symlink that leads into the host's state is refused too, so a link cannot launder the path", () => {
  const root = mkdtempSync(join(tmpdir(), "dh-state-guard-"));
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "host-key.json"), "{}");
  symlinkSync(state, join(root, "innocent"));
  const context = { stateDirs: [state], home: root, cwd: root };
  for (const path of [join(root, "innocent", "host-key.json"), join(root, "innocent"), "innocent/host-key.json"]) {
    expect([path, planCall(["file", "read", path], context)]).toEqual([
      path,
      { kind: "refused", message: "that path is the host's private state" },
    ]);
  }
});

test("no word of a file or put command reaches the host's state: after --, as a flag value, or as the last word", () => {
  const state = "/home/me/.local/state/doriface-host/host-key.json";
  for (const args of [
    ["file", "read", "--", state],
    ["file", "write", "--", state],
    ["file", "bytes", "/tmp/x", "--offset", state],
    ["put", "t1", "--", state],
  ]) {
    expect([args, plan(args)]).toEqual([args, { kind: "refused", message: "that path is the host's private state" }]);
  }
});

test("on another machine a path into a doriface-host state dir is refused by its name, ~ and relative forms too", () => {
  for (const path of [
    "~/.local/state/doriface-host/host-key.json",
    ".local/state/doriface-host-mesh/devices.json",
    "/home/x/.local/state/doriface-host",
  ]) {
    const args = ["file", "read", "--on", "studio", path];
    expect([args, plan(args).kind]).toEqual([args, "refused"]);
  }
  expect(plan(["file", "read", "--on", "studio", "~/notes.txt"]).kind).toBe("hc");
});

test("the state guard is not fooled by case or by unnormalized spelling, here or on another machine", () => {
  for (const args of [
    ["file", "read", "/home/me/.local/STATE/doriface-host/host-key.json"],
    ["file", "read", "/HOME/ME/.local/state/DORIFACE-HOST/devices.json"],
    ["file", "read", "--on", "studio", "/Users/x/.local/state/./doriface-host/host-key.json"],
    ["file", "read", "--on", "studio", "/Users/x/.local//state/doriface-host-mesh/devices.json"],
    ["file", "read", "--on", "studio", "~/.LOCAL/State/Doriface-Host/host-key.json"],
  ]) {
    expect([args, plan(args).kind]).toEqual([args, "refused"]);
  }
});

test("a long s or other compatibility spelling does not get past the name check", () => {
  for (const path of [
    "~/.local/\u017ftate/doriface-ho\u017ft/host-key.json",
    "/home/me/.local/\u017ftate/doriface-host/x",
  ]) {
    const args = ["file", "read", "--on", "studio", path];
    expect([args, plan(args).kind]).toEqual([args, "refused"]);
  }
});

test("a search from above a custom-named state dir excludes that dir by its name", () => {
  const custom = { stateDirs: ["/srv/hosts/studio-state"], home: "/home/me", cwd: "/" };
  expect(planCall(["file", "grep", "/srv/hosts", "needle"], custom)).toMatchObject({
    kind: "file",
    args: { path: "/srv/hosts", pattern: "needle", exclude: ["studio-state"] },
  });
});
