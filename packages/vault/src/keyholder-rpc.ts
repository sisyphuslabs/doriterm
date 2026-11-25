import { type Envelope, EnvelopeSchema, type EntryPayload, type PublicKey } from "typevault/core";
import type { KeyProtection } from "./context.ts";
import type { EntryDraft, Keyholder, TierHandle } from "./keyholder.ts";

/**
 * The keyholder's calls as plain data, for a boundary that copies messages (Electron IPC, a Worker's postMessage).
 * A handle crosses as its id; the key it names stays with the serving side.
 */
export type KeyholderRequest =
  | { readonly op: "info" }
  | { readonly op: "unwrap"; readonly sealed: Uint8Array; readonly gen: number; readonly expected: PublicKey }
  | { readonly op: "generate"; readonly gen: number }
  | { readonly op: "open"; readonly id: string; readonly envelope: Envelope }
  | { readonly op: "seal"; readonly id: string; readonly draft: EntryDraft }
  | { readonly op: "wrap"; readonly id: string; readonly recipient: string };

type HandleInfo = { readonly id: string; readonly gen: number; readonly publicKey: PublicKey };

const MAX_SEALED = 64 * 1024;
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value !== "";
const genOf = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function publicKeyIn(value: unknown): PublicKey | undefined {
  const recipient = field(value, "recipient");
  const signPublic = field(value, "signPublic");
  return text(recipient) && text(signPublic) ? { recipient, signPublic } : undefined;
}

/** A request as received across the boundary, checked; anything else is refused. */
function parseRequest(value: unknown): KeyholderRequest {
  const op = field(value, "op");
  const id = field(value, "id");
  if (op === "info") return { op };
  if (op === "generate" && genOf(field(value, "gen"))) return { op, gen: Number(field(value, "gen")) };
  if (op === "unwrap") {
    const sealed = field(value, "sealed");
    const gen = field(value, "gen");
    const expected = publicKeyIn(field(value, "expected"));
    if (sealed instanceof Uint8Array && sealed.length <= MAX_SEALED && genOf(gen) && expected !== undefined)
      return { op, sealed, gen, expected };
  }
  if (op === "open" && text(id)) {
    const envelope = EnvelopeSchema.safeParse(field(value, "envelope"));
    if (envelope.success) return { op, id, envelope: envelope.data };
  }
  if (op === "seal" && text(id)) {
    const draft = field(value, "draft");
    const [draftId, rev, at, payload] = ["id", "rev", "at", "payload"].map((key) => field(draft, key));
    if (text(draftId) && genOf(rev) && text(at) && typeof payload === "object" && payload !== null)
      return { op, id, draft: { id: draftId, rev, at, payload: payload as EntryPayload } };
  }
  if (op === "wrap" && text(id) && text(field(value, "recipient")))
    return { op, id, recipient: String(field(value, "recipient")) };
  throw new Error("not a keyholder request");
}

/**
 * The serving side: answers requests with handle ids, never key material. The payload of a `seal` is checked by
 * TypeVault's own codec when it is sealed, so a malformed one fails there.
 */
export function serveKeyholder(holder: Keyholder): (request: unknown) => Promise<unknown> {
  const handles = new Map<string, TierHandle>();
  const keep = (handle: TierHandle): HandleInfo => {
    // Random: only code that was handed this id can use the handle, not code that read the public document.
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    handles.set(id, handle);
    return { id, gen: handle.gen, publicKey: handle.publicKey };
  };
  const held = (id: string): TierHandle => {
    const handle = handles.get(id);
    if (handle === undefined) throw new Error("no such tier key here");
    return handle;
  };
  return async (raw) => {
    const request = parseRequest(raw);
    switch (request.op) {
      case "info":
        return { recipient: holder.recipient, protection: holder.protection };
      case "unwrap": {
        const handle = await holder.unwrap(request.sealed, request.gen, request.expected);
        return handle === undefined ? null : keep(handle);
      }
      case "generate":
        return keep(await holder.generate(request.gen));
      case "open":
        return (await held(request.id).open(request.envelope)) ?? null;
      case "seal":
        return held(request.id).seal(request.draft);
      case "wrap":
        return held(request.id).wrapFor(request.recipient);
    }
  };
}

const PROTECTIONS: readonly KeyProtection[] = ["unprotected", "non-extractable", "os-keystore"];

function handleIn(value: unknown, call: (request: KeyholderRequest) => Promise<unknown>): TierHandle {
  const id = field(value, "id");
  const gen = field(value, "gen");
  const publicKey = publicKeyIn(field(value, "publicKey"));
  if (!text(id) || !genOf(gen) || publicKey === undefined) throw new Error("the keyholder returned no tier key handle");
  return {
    gen,
    publicKey,
    open: async (envelope) => {
      const payload = await call({ op: "open", id, envelope });
      return payload === null ? undefined : (payload as EntryPayload);
    },
    seal: async (draft) => EnvelopeSchema.parse(await call({ op: "seal", id, draft })),
    wrapFor: async (recipient) => {
      const sealed = await call({ op: "wrap", id, recipient });
      if (!(sealed instanceof Uint8Array)) throw new Error("the keyholder returned no wrap");
      return sealed;
    },
  };
}

/** The calling side: a keyholder whose every call crosses `call`, so no tier key ever exists on this side. */
export async function remoteKeyholder(call: (request: KeyholderRequest) => Promise<unknown>): Promise<Keyholder> {
  const info = await call({ op: "info" });
  const recipient = field(info, "recipient");
  const protection = PROTECTIONS.find((known) => known === field(info, "protection"));
  if (!text(recipient) || protection === undefined) throw new Error("the keyholder returned no vault key");
  return {
    recipient,
    protection,
    unwrap: async (sealed, gen, expected) => {
      const answer = await call({ op: "unwrap", sealed, gen, expected });
      return answer === null ? undefined : handleIn(answer, call);
    },
    generate: async (gen) => handleIn(await call({ op: "generate", gen }), call),
  };
}
