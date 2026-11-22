import { SPACE_LABEL, type Terminal } from "@doriface/protocol";
import { renameSpace as renamedIn } from "@doriface/protocol/layout";
import type { ListedSpace } from "./model.ts";
import { isGone, type SessionCalls } from "./session-actions.ts";
import { spacePlace } from "./space-place.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

/** Why space `id` cannot be renamed now: its layout takes no edits (or it is gone); null when it can. */
export function renameRefusal(layouts: readonly MachineLayout[], id: string): string | null {
  const place = spacePlace(layouts, id);
  if (place === undefined) return "This space is no longer in the layout.";
  const { readOnly } = place.layout;
  return readOnly === null ? null : `The layout cannot take changes now: ${readOnly}`;
}

/**
 * Why `name` cannot become space `id`'s name, or null when it can: a blank name, or one another space of the same
 * machine is shown under. Its own name is fine (nothing changes).
 */
export function spaceNameProblem(spaces: readonly ListedSpace[], id: string, name: string): string | null {
  const wanted = name.trim();
  if (wanted === "") return "A space needs a name.";
  const machine = spaces.find((space) => space.id === id)?.machine;
  const taken = spaces.some((space) => space.id !== id && space.machine === machine && space.name === wanted);
  return taken ? `Another space on this machine is already called ${wanted}.` : null;
}

/**
 * Names space `id` `name` (trimmed) as herdr-app does: the space's `name` in its machine's layout document, which every
 * client of the host reads, relayed ones included. Its live terminals get the same `space` label in hc, so one that
 * leaves every tab is adopted back into it; a terminal removed meanwhile is no failure. Rejects with why it was not
 * written: a layout that takes no edits, a refused document write, or a refused label once every call has settled.
 */
export async function renameSpace(
  calls: Pick<SessionCalls, "label">,
  layouts: readonly MachineLayout[],
  spaces: readonly ListedSpace[],
  terminals: readonly Terminal[],
  id: string,
  name: string,
): Promise<void> {
  const wanted = name.trim();
  const refusal = renameRefusal(layouts, id);
  const place = spacePlace(layouts, id);
  if (refusal !== null || place === undefined) throw new Error(refusal ?? "This space is no longer in the layout.");
  await place.layout.edit((doc) => (doc === null ? null : renamedIn(doc, place.space, wanted)));
  const addresses = new Set(spaces.find((space) => space.id === id)?.addresses ?? []);
  const members = terminals.filter((terminal) => terminal.state === "live" && addresses.has(terminal.address));
  const outcomes = await Promise.allSettled(
    members.map((terminal) => calls.label({ terminal: terminal.address, labels: { [SPACE_LABEL]: wanted } })),
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected" && !isGone(outcome.reason));
  if (failed?.status === "rejected") throw failed.reason;
}
