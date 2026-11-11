import type { Terminal } from "@doriface/protocol";
import { removeSpace as removedSpace } from "@doriface/protocol/layout";
import type { ListedSpace } from "./model.ts";
import { endSession, isGone, type SessionCalls } from "./session-actions.ts";
import { spacePlace } from "./space-place.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

/** Why space `id` cannot be closed now: its layout takes no edits (or it is gone); null when it can. */
export function closeRefusal(layouts: readonly MachineLayout[], id: string): string | null {
  const place = spacePlace(layouts, id);
  if (place === undefined) return "This space is no longer in the layout.";
  const { readOnly } = place.layout;
  return readOnly === null ? null : `The layout cannot take changes now: ${readOnly}`;
}

/** How a space close reports what it did to the page's drop-once rule (use-drop-once.ts). */
export interface SpaceCloseDrops {
  /** Records these sessions as dropped by a close that writes their whole space out in one edit, before their Ends report them. */
  readonly closing: (addresses: readonly string[]) => void;
  /** An End failed and this session keeps running: its later end drops its pane again. */
  readonly kept: (address: string) => void;
}

const NO_DROPS: SpaceCloseDrops = { closing: () => undefined, kept: () => undefined };

/**
 * Closes space `id` as herdr-app's `space.close` does: ends every program its tabs run, then takes the space and its
 * tabs out of that machine's layout document, which every client of the machine reads (relayed ones included). It
 * rejects with why it did not close — a layout that takes no edits, or a session that would not end (the space then
 * stays, without the sessions that did end): a terminal left running would be adopted back into the space by its label
 * on the next load, so the space only really goes once its programs have.
 *
 * The space's removal is the one layout write this action makes: every session it ends is recorded as dropped first, so
 * their Ends do not write their panes out one by one and report a refused write each (#1337).
 */
export async function closeSpace(
  calls: SessionCalls,
  layouts: readonly MachineLayout[],
  spaces: readonly ListedSpace[],
  terminals: readonly Terminal[],
  id: string,
  drops: SpaceCloseDrops = NO_DROPS,
): Promise<void> {
  const refusal = closeRefusal(layouts, id);
  const place = spacePlace(layouts, id);
  if (refusal !== null || place === undefined) throw new Error(refusal ?? "This space is no longer in the layout.");
  const addresses = new Set(spaces.find((space) => space.id === id)?.addresses ?? []);
  const members = terminals.filter((terminal) => terminal.state === "live" && addresses.has(terminal.address));
  drops.closing(members.map((terminal) => terminal.address));
  const outcomes = await Promise.allSettled(members.map((terminal) => endSession(calls, terminal.address)));
  outcomes.forEach((outcome, index) => {
    const member = members[index];
    if (outcome.status === "rejected" && !isGone(outcome.reason) && member !== undefined) drops.kept(member.address);
  });
  const failed = outcomes.find((outcome) => outcome.status === "rejected" && !isGone(outcome.reason));
  if (failed?.status === "rejected") throw failed.reason;
  await place.layout.edit((doc) => (doc === null ? null : removedSpace(doc, place.space)));
}
