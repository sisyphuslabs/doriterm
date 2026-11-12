import type { Roster } from "./roster.ts";

/** Resolves once `ok` holds, woken only by the roster's own changes; fails loudly instead of hanging. */
export function until(roster: Roster, ok: () => boolean, label: string): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${label}`));
    }, 2_000);
    const stop = roster.subscribe(() => {
      if (!ok()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** The space ids a machine's document lists once read (an unwritten document lists none); undefined before its read. */
export const spaceIds = (roster: Roster, on: string | null): readonly string[] | undefined => {
  const state = roster.docs.stateOf(on);
  if (state?.phase !== "ready") return undefined;
  if (state.doc === null) return [];
  const spaces = state.doc["spaces"];
  return Array.isArray(spaces)
    ? spaces.flatMap((each) => (typeof each === "object" && each !== null && "id" in each ? [String(each.id)] : []))
    : [];
};
