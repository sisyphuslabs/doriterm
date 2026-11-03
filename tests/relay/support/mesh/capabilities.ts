import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI = join(ROOT, "apps", "host", "src", "cli.ts");

export const CAPABILITIES = ["cli", "bridge", "records", "wire", "reconciler"] as const;
export type Capability = (typeof CAPABILITIES)[number];

const RECORD_API = ["encodeBody", "signRecord", "signCard", "hashOf", "viewOf"] as const;
const MESH_COMMANDS = ["pair", "join", "revoke", "status", "leave", "rename"] as const;

async function run(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return (await proc.exited) === 0 ? `${stdout}${stderr}` : "";
}

/** `doriface-host mesh --help` lists every command the scenarios drive. */
async function hasMeshCli(): Promise<boolean> {
  const help = await run(["mesh", "--help"]);
  return MESH_COMMANDS.every((command) => help.includes(`mesh ${command}`));
}

async function hasBridge(): Promise<boolean> {
  return (await run(["connect", "--help"])).includes("--mesh");
}

/** `packages/mesh` (PR 2) exports what signing and the door need, loaded by path so this file builds without it. */
export async function loadMeshLib(): Promise<Readonly<Record<string, unknown>> | undefined> {
  const entry = join(ROOT, "packages", "mesh", "src", "index.ts");
  if (!existsSync(entry)) return undefined;
  const loaded: unknown = await import(entry);
  if (typeof loaded !== "object" || loaded === null) return undefined;
  const lib: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(loaded));
  return RECORD_API.every((name) => typeof lib[name] === "function") ? lib : undefined;
}

/** The mesh stream is a handshake payload value (PR 3): the crypto package must know it before a test may open one. */
function hasMeshStream(): boolean {
  const payloads = join(ROOT, "packages", "crypto", "src", "payloads.ts");
  return existsSync(payloads) && readFileSync(payloads, "utf8").includes('"mesh"');
}

export type Present = Readonly<Record<Capability, boolean>>;

export async function detect(): Promise<Present> {
  const [cli, bridge, lib] = await Promise.all([hasMeshCli(), hasBridge(), loadMeshLib()]);
  return {
    cli,
    bridge,
    records: lib !== undefined,
    wire: hasMeshStream(),
    reconciler: cli && bridge && existsSync(join(ROOT, "apps", "host", "src", "mesh", "reconciler.ts")),
  };
}

/** `DORIFACE_MESH_E2E=require` turns a missing capability into a failure, which is how the final stack runs them. */
export const REQUIRED = process.env["DORIFACE_MESH_E2E"] === "require";

export function missing(present: Present, needs: readonly Capability[]): readonly Capability[] {
  return needs.filter((need) => !present[need]);
}

export function gate(present: Present, needs: readonly Capability[]): { readonly run: boolean; readonly why: string } {
  const absent = missing(present, needs);
  if (absent.length === 0) return { run: true, why: "" };
  if (REQUIRED) throw new Error(`DORIFACE_MESH_E2E=require but these capabilities are missing: ${absent.join(", ")}`);
  return { run: false, why: `needs ${absent.join(", ")} (PR 1-8 not on this branch yet)` };
}
