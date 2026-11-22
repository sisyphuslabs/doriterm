import type { ApprovalCore } from "./approval-live.ts";
import type { ApprovalRecord } from "./approval-records.ts";

/**
 * How long a `claimed` record holds its prompt, measured on the OBSERVER's own clock from the moment it first saw that
 * record. A live claim settles within a few round trips; one still unsettled after this long belongs to a client that
 * went away, and the prompt is answerable again. No device's clock is ever compared with another's.
 */
export const CLAIM_TTL_MS = 20_000;

/**
 * How early the claimer stops trusting its own claim. It presses only while less than `CLAIM_TTL_MS - FENCE_MARGIN_MS`
 * has passed on its clock since it claimed; another client retakes only after `CLAIM_TTL_MS` of its own observation,
 * which starts no earlier than the claim was written. The margin covers the claimer's last check and its key press.
 */
export const FENCE_MARGIN_MS = 5_000;

/** One client's monotonic clock, and when it first saw each claim (by that clock). */
export interface ApprovalClock {
  readonly now: () => number;
  readonly firstSeen: Map<string, number>;
}

export const approvalClock = (now: () => number = () => performance.now()): ApprovalClock => ({
  now,
  firstSeen: new Map(),
});

const clocks = new WeakMap<ApprovalCore, ApprovalClock>();

/** The clock answers through a core use when the caller brings none: one per core, so one per client connection. */
export function clockOf(core: ApprovalCore): ApprovalClock {
  const known = clocks.get(core);
  if (known !== undefined) return known;
  const made = approvalClock();
  clocks.set(core, made);
  return made;
}

const sighting = (record: ApprovalRecord): string =>
  `${record.prompt}|${record.client}|${record.attempt ?? ""}|${record.atMs}|${record.answer}`;

/** Sightings older than this are of prompts long gone; they are dropped so the map stays small. */
const FORGET_MS = 10 * CLAIM_TTL_MS;

/** How long this client has watched this `claimed` record, starting its watch now if it never saw it. */
function watched(record: ApprovalRecord, clock: ApprovalClock, scope = ""): number {
  const now = clock.now();
  for (const [key, at] of clock.firstSeen) if (now - at > FORGET_MS) clock.firstSeen.delete(key);
  const key = scope + sighting(record);
  const since = clock.firstSeen.get(key);
  if (since === undefined) clock.firstSeen.set(key, now);
  return now - (since ?? now);
}

/** A history trim observes a claim for eviction, not on behalf of a later answer to that prompt. */
export function liveForRetention(record: ApprovalRecord, clock: ApprovalClock): boolean {
  return record.outcome === "claimed" && watched(record, clock, "retention:") < CLAIM_TTL_MS;
}

/**
 * Whether this record keeps a new answer from claiming its prompt. Our own unsettled claim holds like any other, except
 * the one claim whose attempt id the caller names in `retake`, and only when that claim is this client's own (`client`):
 * an answer of its own that it knows ended without a press. Another client's attempt id never takes over its claim.
 */
export function holds(record: ApprovalRecord, clock: ApprovalClock, retake?: string, client?: string): boolean {
  switch (record.outcome) {
    case "sent":
    case "stale":
    case "unknown":
      return true;
    case "failed":
      return false;
    case "claimed":
      if (retake !== undefined && record.attempt === retake && record.client === client) return false;
      return watched(record, clock) < CLAIM_TTL_MS;
  }
}
