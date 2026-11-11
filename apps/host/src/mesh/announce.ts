/** What a committed membership write needs of a host to tell the running sync layer, and to say so when it cannot. */
export interface ChangeAnnouncer {
  /** Announces a committed membership write so sync pushes the new records; absent when nothing is running. */
  readonly changed?: (() => void) | undefined;
  readonly log: (line: string) => void;
}

/**
 * Announces a committed membership write without letting the announcement undo it: the records are signed and stored
 * before this runs, so a sync layer that refuses is logged and the caller carries on (#1473).
 */
export function announceChange(deps: ChangeAnnouncer): void {
  if (deps.changed === undefined) return;
  try {
    deps.changed();
  } catch (error) {
    deps.log(`mesh: cannot announce the membership change: ${error instanceof Error ? error.message : String(error)}`);
  }
}
