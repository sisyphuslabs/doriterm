import type { JsonObject } from "@doriface/protocol";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { FILE_TOOLS, type FileTool } from "./file-tools.ts";
import { HOST_TOOLS, MESH_TOOLS, type MeshTool } from "./mesh-tools.ts";

export type Scope = "read" | "act" | "mesh";

export const SKILL_URI = "doriterm://skill/SKILL.md";

/** The one tool a session sees. Its description opens with the skill, which is the manual for every verb. */
export const ONE_TOOL = {
  name: "doriterm",
  description:
    `Read ${SKILL_URI} before your first call (resources/read; or call this tool with args ["skill"]). ` +
    "Runs one Doriterm command on the machine this session is paired with, exactly as the hc CLI takes it: " +
    'args ["ls"], ["run","--bg","claude"], ["read","t3"], ["send","t3","hello"], ["exec","uname -a"], ' +
    '["file","read","/etc/hostname"], ["machine","ls"]; plus ["file","list"|"stat"|"glob"|"grep"|"bytes",...], ' +
    '["doc","get"|"set",...], ["mesh",...], ["devices",...] and ["host","status"]. Answers exitCode, stdout and stderr.',
  inputSchema: {
    type: "object",
    properties: {
      args: { type: "array", items: { type: "string" }, description: "The command and its arguments, as for hc." },
      stdin: { type: "string", description: "Text for the command's stdin (file write, exec -i)." },
      timeoutSeconds: { type: "integer", description: "At most this long (default 60, at most 600)." },
    },
    required: ["args"],
    additionalProperties: false,
  },
} as const;

/** What one call asks for, decided before anything runs. */
export type Plan =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "skill"; readonly scope: Scope }
  | { readonly kind: "hc"; readonly argv: readonly string[]; readonly scope: Scope }
  | { readonly kind: "mesh"; readonly tool: MeshTool; readonly args: JsonObject; readonly scope: Scope }
  | { readonly kind: "file"; readonly tool: FileTool; readonly args: JsonObject; readonly scope: Scope }
  | {
      readonly kind: "rpc";
      readonly method: "doc.get" | "doc.set" | "machine.connect";
      readonly args: JsonObject;
      readonly scope: Scope;
    };

const READ_VERBS: ReadonlySet<string> = new Set(["ls", "get", "read", "wait", "templates", "schema"]);
const ACT_VERBS: ReadonlySet<string> = new Set([
  "run",
  "exec",
  "send",
  "keys",
  "interrupt",
  "put",
  "kill",
  "rm",
  "label",
  "keep",
]);
const REFUSED: Readonly<Record<string, string>> = {
  attach: "attach takes over a terminal interactively; use read, send and wait",
  connect: "connect is the API itself",
  events: "events streams forever; use wait, or MCP's subscriptions/listen",
  update: "updating hc is the machine owner's act",
};

const meshTool = (name: string): MeshTool => {
  const tool = [...HOST_TOOLS, ...MESH_TOOLS].find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no ${name}`);
  return tool;
};
const fileTool = (name: string): FileTool => {
  const tool = FILE_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no ${name}`);
  return tool;
};
const refused = (message: string): Plan => ({ kind: "refused", message });

/** `--key value` and `--flag` pairs after the positional words, as the host's own CLI reads them. */
function flags(words: readonly string[]): {
  readonly positional: string[];
  readonly named: Record<string, string | true>;
} {
  const positional: string[] = [];
  const named: Record<string, string | true> = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (!word.startsWith("--")) positional.push(word);
    else if (word.includes("=")) named[word.slice(2, word.indexOf("="))] = word.slice(word.indexOf("=") + 1);
    else if (index + 1 < words.length && !(words[index + 1] ?? "").startsWith("--"))
      named[word.slice(2)] = words[++index] ?? "";
    else named[word.slice(2)] = true;
  }
  return { positional, named };
}

/**
 * A path a file verb names must not reach the host's private state (keys, paired devices, the mesh): those would let an
 * agent take the host's identity. `~` and relative paths are resolved the way hc resolves them on this machine.
 */
export function touchesState(path: string, stateDirs: readonly string[], home: string, cwd: string): boolean {
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  const full = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  const inside = (candidate: string): boolean =>
    stateDirs.some((dir) => candidate === dir || candidate.startsWith(`${normalize(dir)}/`));
  if (inside(full)) return true;
  try {
    return inside(realpathSync(full));
  } catch {
    return false;
  }
}

export interface PlanContext {
  /** This host's state dir and any other doriface-host state on this machine. */
  readonly stateDirs: readonly string[];
  readonly home: string;
  readonly cwd: string;
}

/** Decides what `args` runs and which scope it needs, refusing what an MCP session must never do. */
export function planCall(args: readonly string[], context: PlanContext): Plan {
  const [verb = "", sub = "", ...rest] = args;
  if (verb === "") return refused('args names no command; start with ["skill"]');
  if (verb === "help" || verb === "skill" || verb === "--help") return { kind: "skill", scope: "read" };
  const reason = REFUSED[verb];
  if (reason !== undefined) return refused(reason);
  if (verb === "server") {
    if (sub === "status") return { kind: "hc", argv: args, scope: "read" };
    if (sub === "start") return { kind: "hc", argv: args, scope: "act" };
    return refused("stopping or restarting the core is the machine owner's act");
  }
  if (verb === "machine") {
    if (sub === "ls") return { kind: "hc", argv: args, scope: "read" };
    if (sub === "add" || sub === "rename" || sub === "update") return { kind: "hc", argv: args, scope: "act" };
    if (sub === "connect")
      return { kind: "rpc", method: "machine.connect", args: { machine: rest[0] ?? "" }, scope: "act" };
    return refused(
      sub === "rm" ? "removing a machine is the machine owner's act" : `machine ${sub} is not available here`,
    );
  }
  if (verb === "file") return planFile(sub, rest, args, context);
  if (
    verb === "put" &&
    rest.length > 0 &&
    touchesState(rest.at(-1) ?? "", context.stateDirs, context.home, context.cwd)
  ) {
    return refused("that path is the host's private state");
  }
  if (verb === "doc") {
    const { positional, named } = flags(rest);
    if (sub === "get")
      return { kind: "rpc", method: "doc.get", args: { name: positional[0] ?? named["name"] ?? "" }, scope: "read" };
    if (sub === "set")
      return {
        kind: "rpc",
        method: "doc.set",
        args: { name: positional[0] ?? "", text: positional[1] ?? "" },
        scope: "act",
      };
    return refused("doc takes get or set");
  }
  if (verb === "mesh" || verb === "devices" || verb === "host") return planMesh(verb, sub, rest);
  if (READ_VERBS.has(verb)) return { kind: "hc", argv: args, scope: "read" };
  if (ACT_VERBS.has(verb)) return { kind: "hc", argv: args, scope: "act" };
  return refused(`unknown command ${verb}; read ${SKILL_URI}`);
}

function planFile(sub: string, rest: readonly string[], args: readonly string[], context: PlanContext): Plan {
  const { positional, named } = flags(rest);
  const path = positional[0] ?? "";
  if (path !== "" && touchesState(path, context.stateDirs, context.home, context.cwd)) {
    return refused("that path is the host's private state");
  }
  const where = typeof named["on"] === "string" ? { on: named["on"] } : {};
  if (sub === "read") return { kind: "hc", argv: args, scope: "read" };
  if (sub === "write" || sub === "edit") return { kind: "hc", argv: args, scope: "act" };
  if (sub === "list") return { kind: "file", tool: fileTool("file_list"), args: { path, ...where }, scope: "read" };
  if (sub === "stat") return { kind: "file", tool: fileTool("file_stat"), args: { path, ...where }, scope: "read" };
  if (sub === "glob")
    return {
      kind: "file",
      tool: fileTool("file_glob"),
      args: { path, pattern: positional[1] ?? "", ...where },
      scope: "read",
    };
  if (sub === "grep") {
    const grep = { path, pattern: positional[1] ?? "", ignoreCase: named["ignore-case"] === true, ...where };
    return { kind: "file", tool: fileTool("file_grep"), args: grep, scope: "read" };
  }
  if (sub === "bytes") {
    const bytes = {
      path,
      ...where,
      ...(typeof named["offset"] === "string" ? { offset: Number(named["offset"]) } : {}),
      ...(typeof named["length"] === "string" ? { length: Number(named["length"]) } : {}),
    };
    return { kind: "file", tool: fileTool("file_read_bytes"), args: bytes, scope: "read" };
  }
  return refused("file takes read, write, edit, list, stat, glob, grep or bytes");
}

function planMesh(verb: string, sub: string, rest: readonly string[]): Plan {
  const { positional, named } = flags(rest);
  const yes = named["yes"] === true;
  const expect = typeof named["expect"] === "string" ? named["expect"].split(",") : undefined;
  const confirm = { ...(yes ? { yes: true } : {}), ...(expect === undefined ? {} : { expect }) };
  if (verb === "host")
    return sub === "status"
      ? { kind: "mesh", tool: meshTool("host_status"), args: {}, scope: "read" }
      : refused("host takes status");
  if (verb === "devices") {
    if (sub === "list") return { kind: "mesh", tool: meshTool("mesh_status"), args: {}, scope: "read" };
    if (sub === "revoke")
      return { kind: "mesh", tool: meshTool("mesh_device_revoke"), args: { id: positional[0] ?? "" }, scope: "mesh" };
    return refused("devices takes list or revoke");
  }
  if (sub === "status") return { kind: "mesh", tool: meshTool("mesh_status"), args: {}, scope: "read" };
  if (sub === "invite")
    return { kind: "mesh", tool: meshTool("mesh_invite"), args: { kind: positional[0] ?? "" }, scope: "mesh" };
  if (sub === "join") {
    const approve = positional[1] === "approve";
    const answer = { join: positional[0] ?? "", approve, ...(approve ? { code: positional[2] ?? "" } : {}) };
    return { kind: "mesh", tool: meshTool("mesh_join_answer"), args: answer, scope: "mesh" };
  }
  if (sub === "revoke") {
    const revoke = {
      member: positional[0] ?? "",
      ...(named["compromised"] === true ? { compromised: true } : {}),
      ...confirm,
    };
    return { kind: "mesh", tool: meshTool("mesh_revoke"), args: revoke, scope: "mesh" };
  }
  if (sub === "rename")
    return {
      kind: "mesh",
      tool: meshTool("mesh_rename"),
      args: { member: positional[0] ?? "", name: positional[1] ?? "" },
      scope: "mesh",
    };
  if (sub === "leave") return { kind: "mesh", tool: meshTool("mesh_leave"), args: confirm, scope: "mesh" };
  return refused("mesh takes status, invite, join, revoke, rename or leave");
}
