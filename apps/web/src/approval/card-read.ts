import {
  type ApprovalCore,
  type ApprovalMark,
  hasPromptReader,
  readApproval,
  type Terminal,
  waitsOnApproval,
} from "@doriface/protocol";
import type { CardState } from "./waiting-keys.ts";

/** The status event can land before the agent has drawn its dialog: read again a few times, backing off. */
export const DRAW_WAITS_MS = [0, 150, 300, 600, 1200];

/** Waits `ms`, or less if the signal aborts first. */
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

export const pause: Pause = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (ms === 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function readWhenDrawn(
  core: ApprovalCore,
  address: string,
  signal: AbortSignal,
  wait: Pause,
  waits: readonly number[] = DRAW_WAITS_MS,
): Promise<ApprovalMark | undefined> {
  const [ms, ...later] = waits;
  if (ms === undefined) return undefined;
  await wait(ms, signal);
  if (signal.aborted) return undefined;
  return (await readApproval(core, address)) ?? readWhenDrawn(core, address, signal, wait, later);
}

/** The screen read one wait is keyed by: a new turn on the same terminal is a new read. */
export const readKeyOf = (terminal: Terminal): string => `${terminal.address}\n${terminal.turn ?? 0}`;

/**
 * Where a terminal's card stands (#1555): up; still being read for, while this wait's screen read has not finished on an
 * agent whose dialogs this client reads (#192); or none coming. `read` is the key of the last read that finished.
 */
export function cardState(terminal: Terminal, shown: boolean, read: string | undefined): CardState {
  if (shown) return "shown";
  const reads = waitsOnApproval(terminal) && hasPromptReader(terminal.status?.app ?? "");
  return reads && read !== readKeyOf(terminal) ? "reading" : "none";
}

/**
 * Reads a terminal's screen for its dialog until one is drawn or the draw waits run out: `drawn` gets the dialog when one
 * comes, then `finished` says the read is over, found or not, unless it was aborted first.
 */
export async function readCard(
  core: ApprovalCore,
  address: string,
  signal: AbortSignal,
  on: { readonly drawn: (mark: ApprovalMark) => void; readonly finished: () => void },
  wait: Pause = pause,
): Promise<void> {
  try {
    const mark = await readWhenDrawn(core, address, signal, wait);
    if (mark !== undefined && !signal.aborted) on.drawn(mark);
  } catch {
    // The read failed (a dropped connection): no banner; the pane keeps "Needs you" and the terminal stays answerable.
  }
  if (!signal.aborted) on.finished();
}
