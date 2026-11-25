import { type ApprovalClock, clockOf, liveForRetention } from "./approval-clock.ts";
import type { ApprovalCore } from "./approval-live.ts";
import { type ApprovalMark, approvalKey } from "./approval-prompt.ts";
import type { ApprovalAnswer } from "./approval-screen.ts";
import { isJsonObject, type JsonValue } from "./json.ts";

/** Who answers: a device name people recognise, and this client's own id, so two tabs of one browser are told apart. */
export interface Answerer {
  readonly by: string;
  readonly client: string;
}

/**
 * `claimed`: the claimer is checking the screen and pressing. `sent`: the agent's key was delivered. `stale`: the prompt
 * had gone; nothing was pressed. `failed`: the answer stopped before any key press (a dropped connection, a claim that
 * lapsed); anyone may answer again, through the same re-check. `unknown`: the key press itself failed, so it may have
 * reached the agent; the prompt is held until the screen moves, and no client answers it again.
 */
export type ApprovalOutcome = "claimed" | "sent" | "stale" | "failed" | "unknown";

export interface ApprovalRecord extends Answerer {
  readonly prompt: string;
  /** Allow or Deny, as clients that only know those two read it: a decline (the agent's No row, its cancel) or not. */
  readonly answer: ApprovalAnswer;
  /** The answer in the agent's own words (a row's label, the checked rows); missing from records of older clients. */
  readonly choice?: string;
  /** The claimer's wall clock when it claimed: for people only, never compared with another device's clock. */
  readonly atMs: number;
  /** One answer's own id: only that answer settles its record or presses under it. */
  readonly attempt?: string;
  readonly outcome: ApprovalOutcome;
}

/** Hard limit per terminal, newest last. History may make room for a claim; a live claim may not. */
const KEPT = 16;
const ATTEMPTS = 8;

function docOf(address: string): { readonly name: string; readonly on: string | undefined } {
  const slash = address.indexOf("/");
  return slash === -1
    ? { name: `approval.${address}`, on: undefined }
    : { name: `approval.${address.slice(slash + 1)}`, on: address.slice(0, slash) };
}

const OUTCOMES: ReadonlySet<unknown> = new Set(["claimed", "sent", "stale", "failed", "unknown"]);

function isRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  const attempt = field("attempt");
  const choice = field("choice");
  return (
    typeof field("prompt") === "string" &&
    (field("answer") === "allow" || field("answer") === "deny") &&
    typeof field("by") === "string" &&
    typeof field("client") === "string" &&
    typeof field("atMs") === "number" &&
    (attempt === undefined || typeof attempt === "string") &&
    (choice === undefined || typeof choice === "string") &&
    OUTCOMES.has(field("outcome"))
  );
}

function recordsIn(value: JsonValue): ApprovalRecord[] {
  const list = isJsonObject(value) ? value["records"] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

const recordJson = (record: ApprovalRecord): JsonValue => ({
  prompt: record.prompt,
  answer: record.answer,
  ...(record.choice === undefined ? {} : { choice: record.choice }),
  by: record.by,
  client: record.client,
  atMs: record.atMs,
  ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
  outcome: record.outcome,
});

/** The terminal's records with `change` applied, or undefined to leave the document as it is. */
export type Change = (records: readonly ApprovalRecord[]) => readonly ApprovalRecord[] | undefined;

function retained(records: readonly ApprovalRecord[], clock: ApprovalClock): readonly ApprovalRecord[] {
  let excess = records.length - KEPT;
  if (excess <= 0) return records;
  // Never drop the new record to make its own write succeed. An abandoned claim is eligible only after this
  // writer has observed it for a full TTL; another device's atMs does not establish its age.
  const kept = records.filter((record, index) => {
    if (excess === 0 || index === records.length - 1 || liveForRetention(record, clock)) {
      return true;
    }
    excess -= 1;
    return false;
  });
  if (excess > 0) throw new Error("approval document is full of live claims; retry after a claim settles or lapses");
  return kept;
}

/** The terminal's records as one read of its approval document found them, and that document's version. */
export interface RecordsRead {
  readonly records: readonly ApprovalRecord[];
  readonly version: number;
}

/**
 * The terminal's approval document, then `change` applied and written back at the version read, retried on a conflict.
 * Returns the records as read when `change` left the document alone, undefined once its write landed. `read` is a read
 * the caller just made: the first write goes at its version without reading again, and a conflict reads afresh (#2718).
 */
export async function update(
  core: ApprovalCore,
  address: string,
  change: Change,
  read?: RecordsRead,
  clock = clockOf(core),
  // A cached fence version can already be stale before settlement starts. On conflict give the fresh read/write
  // loop its normal eight attempts, just as if there had been no cached version.
  attempt = read === undefined ? 1 : 0,
): Promise<readonly ApprovalRecord[] | undefined> {
  const { name, on } = docOf(address);
  const current = read ?? (await readRecords(core, address));
  const next = change(current.records);
  if (next === undefined) return current.records;
  const records = retained(next, clock).map(recordJson);
  if ((await core.setDoc(name, on, { records }, current.version)) === "ok") return undefined;
  if (attempt >= ATTEMPTS) throw new Error(`approval document ${name} kept moving: ${ATTEMPTS} conflicts in a row`);
  return update(core, address, change, undefined, clock, attempt + 1);
}

/** The terminal's records, as the core has them now. */
export async function readRecords(core: ApprovalCore, address: string): Promise<RecordsRead> {
  const { name, on } = docOf(address);
  const doc = await core.doc(name, on);
  return { records: recordsIn(doc.value), version: doc.version };
}

/** What was recorded for the marked prompt, by whichever client answered it. */
export async function readApprovalRecord(core: ApprovalCore, mark: ApprovalMark): Promise<ApprovalRecord | undefined> {
  const key = approvalKey(mark);
  return (await readRecords(core, mark.terminal)).records.findLast((record) => record.prompt === key);
}
