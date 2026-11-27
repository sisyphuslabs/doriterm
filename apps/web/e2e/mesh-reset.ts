// Puts the mesh panel's documents back to the e2e host's start state, with the fixture's times taken now. The host
// seeds them once when it starts, and the seeded join's offer ends 8 minutes later, while a spec runs whenever the
// single-worker suite reaches it (#127); an answer a spec wrote would also stay for every later spec.
import { MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setCoreDoc } from "./core-doc.ts";

/**
 * With `open` (the default) a join waits for approval: the specs about joins want it. Every such spec puts the start
 * state back (`{ open: false }`) when it ends, because a waiting join raises the approval card over every screen of
 * every later spec in the worker (#2939).
 */
export function resetMeshDocs({ open = true }: { readonly open?: boolean } = {}): void {
  const args = [join(import.meta.dirname, "mesh-doc.ts"), ...(open ? ["open"] : [])];
  const value: unknown = JSON.parse(execFileSync("bun", args, { encoding: "utf8" }));
  setCoreDoc(MESH_STATUS_DOC, value);
  setCoreDoc(MESH_APPROVAL_DOC, {});
}
