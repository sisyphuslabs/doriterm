import { JoinRefused } from "@doriface/mesh/join";
import { isJsonObject, MESH_APPROVAL_DOC } from "@doriface/protocol";
import type { DocStore } from "./status-doc.ts";

export type MeshDecision = (nonce: string, approve: boolean, code?: string) => boolean;

/** An approval document is an input from a client, never evidence that a comparison already happened. */
export async function answerMeshApproval(store: DocStore, decide: MeshDecision): Promise<void> {
  const doc = await store.get(MESH_APPROVAL_DOC);
  const value = doc.value;
  if (!isJsonObject(value) || "decided" in value || "error" in value) return;
  const approve = value["approve"];
  const deny = value["deny"];
  const nonce = typeof deny === "string" ? deny : typeof approve === "string" ? approve : undefined;
  if (nonce === undefined) return;
  const code = typeof value["code"] === "string" ? value["code"] : undefined;
  let result: { readonly decided: boolean } | { readonly error: string };
  try {
    result = { decided: decide(nonce, typeof deny !== "string", code) };
  } catch (error) {
    if (!(error instanceof JoinRefused)) throw error;
    result = { error: error.message };
  }
  await store.set(MESH_APPROVAL_DOC, { ...value, ...result }, doc.version);
}
