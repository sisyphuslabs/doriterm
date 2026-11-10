/**
 * `doriface-host connect` ends like ssh, the program herdr documents a `via` as standing in for: 255 when the
 * connection itself failed and the far side's hc never spoke (a refusal, a failed dial, a line the far side closed
 * before its first byte), 1 when a session that was up ended with an error, 0 on a normal end.
 *
 * herdr reads 255 as "the line never ran there" and keeps its one error. Any other failing code makes it dial again
 * with its Windows line (`cmd /d /c "if exist …\herdr-core.exe …"`, `machines.rs` `probe_windows`), a second bridge
 * run for every refused dial; and once such a dial reaches a member that has just come back, herdr pins that member
 * as Windows until its core restarts (#2019).
 */
export const CONNECTION_FAILED_EXIT = 255;

export interface SessionEnd {
  /** The far side said at least one byte. */
  readonly spoke: boolean;
  /** This side's input reached EOF first: the caller ended the session, whether or not the far side had spoken. */
  readonly endedByCaller: boolean;
  readonly error: Error | undefined;
}

/** The exit code of a session that ended: 255 when the far side ended it before its first byte, else 1 on an error. */
export function sessionExitCode(end: SessionEnd): number {
  if (!end.spoke && !end.endedByCaller) return CONNECTION_FAILED_EXIT;
  return end.error === undefined ? 0 : 1;
}
