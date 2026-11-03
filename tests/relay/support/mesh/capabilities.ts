import { generateHostIdentity } from "@doriface/crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CliProbe, type MeshCommand, probeBridge, probeCli } from "./cli-probes.ts";
import { loadMeshLib } from "./mesh-lib.ts";
import { actorOf, cardOf, foundRecord } from "./records.ts";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");

export const CAPABILITIES = [
  "join",
  "status",
  "revoke",
  "rename",
  "leave",
  "bridge",
  "records",
  "wire",
  "sync",
  "reconciler",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Whether a capability works, judged by what it does; `why` says what the probe saw when it does not. */
export type Verdict = { readonly works: true } | { readonly works: false; readonly why: string };
export type Present = Readonly<Record<Capability, Verdict>>;

/**
 * Any of these on the branch means the mesh stack (PR 2-8) is, at least in part, here. From then on nothing is
 * skipped: a capability that is missing or does not behave is a failure, so drift can never turn into a silent skip.
 */
export const MESH_ARTIFACTS = [
  ["packages", "mesh"],
  ["apps", "host", "src", "mesh"],
  ["apps", "host", "src", "commands", "mesh.ts"],
  ["apps", "host", "src", "commands", "mesh-join.ts"],
] as const;

const WORKS: Verdict = { works: true };
const fails = (why: string): Verdict => ({ works: false, why });

/** Signs a founding record and a card with a fresh key, and checks the founder is the one member of its view. */
async function probeRecords(root: string): Promise<Verdict> {
  const lib = await loadMeshLib(root);
  if (lib === undefined) return fails("no packages/mesh");
  if (typeof lib === "string") return fails(lib);
  try {
    const founder = actorOf(generateHostIdentity(), "probe", "hc-probe");
    const found = foundRecord(lib, founder);
    const view = lib.viewOf([found]);
    if (lib.verifyCard(cardOf(lib, "-", "-", founder)) === undefined) return fails("verifyCard refuses a fresh card");
    if (lib.hashOf(found).length !== 43) return fails("hashOf is not a 43-character hash");
    if (lib.meshIdOf(found).length !== 26) return fails("meshIdOf is not a 26-character id");
    if (!view.members.has(founder.signPub)) return fails("viewOf leaves the founder out of its own mesh");
    return WORKS;
  } catch (error) {
    return fails(`packages/mesh throws: ${String(error)}`);
  }
}

interface Payloads {
  encodeSessionHello(early: Uint8Array, stream?: string): Uint8Array;
  decodeHello(pattern: "IK", payload: Uint8Array): unknown;
}

const isPayloads = (value: unknown): value is Payloads =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "encodeSessionHello") === "function" &&
  typeof Reflect.get(value, "decodeHello") === "function";

/** A session hello written with the `"mesh"` stream (section 10.2) decodes with that stream. */
async function probeWire(root: string): Promise<Verdict> {
  const loaded: unknown = await import(join(root, "packages", "crypto", "src", "payloads.ts")).catch(() => undefined);
  if (!isPayloads(loaded)) return fails("packages/crypto has no session hello codec");
  try {
    const hello: unknown = loaded.decodeHello("IK", loaded.encodeSessionHello(new Uint8Array(0), "mesh"));
    const stream = typeof hello === "object" && hello !== null ? Reflect.get(hello, "stream") : undefined;
    return stream === "mesh" ? WORKS : fails("a session hello does not carry the mesh stream");
  } catch (error) {
    return fails(`the mesh stream is refused: ${String(error)}`);
  }
}

const artifact = (root: string, path: readonly string[], what: string): Verdict =>
  existsSync(join(root, ...path)) ? WORKS : fails(`no ${what} (${path.join("/")})`);

const NO_CLI: CliProbe = {
  join: ["mesh pair"],
  status: ["mesh status"],
  revoke: ["mesh revoke"],
  rename: ["mesh rename"],
  leave: ["mesh leave"],
};

const commandVerdict = (commands: CliProbe, name: MeshCommand): Verdict => {
  const missingHere = commands[name];
  return missingHere.length === 0 ? WORKS : fails(`never reaches the running host: ${missingHere.join(", ")}`);
};

export async function detect(root: string = ROOT): Promise<Present> {
  const cli = join(root, "apps", "host", "src", "cli.ts");
  const [commands, bridge, records, wire] = await Promise.all([
    existsSync(cli) ? probeCli(cli) : NO_CLI,
    existsSync(cli) && probeBridge(cli),
    probeRecords(root),
    probeWire(root),
  ]);
  return {
    join: commandVerdict(commands, "join"),
    status: commandVerdict(commands, "status"),
    revoke: commandVerdict(commands, "revoke"),
    rename: commandVerdict(commands, "rename"),
    leave: commandVerdict(commands, "leave"),
    bridge: bridge ? WORKS : fails("connect --mesh never asks the running host for a line"),
    records,
    wire,
    sync: artifact(root, ["apps", "host", "src", "mesh", "sync.ts"], "mesh sync"),
    reconciler: artifact(root, ["apps", "host", "src", "mesh", "reconciler.ts"], "reconciler"),
  };
}

/** `env` is DORIFACE_MESH_E2E: `require`, or any mesh artifact on the branch, makes a capability that does not work fail. */
export function isRequired(root: string, env: string | undefined): boolean {
  return env === "require" || MESH_ARTIFACTS.some((path) => existsSync(join(root, ...path)));
}

export function missing(present: Present, needs: readonly Capability[]): readonly string[] {
  return needs.flatMap((need) => {
    const verdict = present[need];
    return verdict.works ? [] : [`${need} (${verdict.why})`];
  });
}

/** `skip` only while the stack is absent and nothing requires it; otherwise a capability that does not work fails. */
export type Gate = { readonly kind: "run" } | { readonly kind: "skip" | "fail"; readonly why: string };

export function gate(present: Present, needs: readonly Capability[], required: boolean): Gate {
  const absent = missing(present, needs);
  if (absent.length === 0) return { kind: "run" };
  if (required)
    return { kind: "fail", why: `the mesh e2e requires capabilities that do not work: ${absent.join("; ")}` };
  return { kind: "skip", why: `needs ${absent.join("; ")}: the mesh stack (PR 2-8) is not on this branch` };
}
