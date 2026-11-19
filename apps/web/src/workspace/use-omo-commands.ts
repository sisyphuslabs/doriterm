import type { Terminal } from "@doriface/protocol";
import { useCallback, useState } from "react";
import { machineOf } from "./model.ts";
import { commandCache, type ExecOn, LISTING_TTL_MS, omoProgram, type SlashCommand } from "./omo-commands.ts";

/** What the phone knows of OmO's commands: not asked yet, being read, read (at a time), or the read failed. */
export type CommandList =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly commands: readonly SlashCommand[]; readonly at: number }
  | { readonly kind: "failed" };

export interface OmoCommands {
  readonly list: CommandList;
  /** Reads the list when it is wanted (a `/` typed): never read, failed, or read longer ago than its lifetime. */
  readonly want: () => void;
}

/** Whose list a terminal shows: OmO restarted with another program or in another directory has its own. */
export const listKey = (address: string, program: string | null, cwd: string): string =>
  `${address}\n${program ?? ""}\n${cwd}`;

/** Whether a wanted list is read (again): it was never read, its read failed, or it is older than `ttlMs`. */
export function readsAgain(list: CommandList, now: number, ttlMs: number): boolean {
  if (list.kind === "loading") return false;
  return list.kind !== "ready" || now - list.at >= ttlMs;
}

const shared = commandCache();

export interface OmoCommandsDeps {
  readonly read?: ReturnType<typeof commandCache>;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/**
 * OmO's slash commands for a terminal that runs OmO, read from OmO on that terminal's machine when a `/` is typed;
 * null for any other program. The listing (cached per machine, program and directory) and the clock are replaceable.
 */
export function useOmoCommands(
  exec: ExecOn,
  terminal: Terminal,
  { read = shared, now = Date.now, ttlMs = LISTING_TTL_MS }: OmoCommandsDeps = {},
): OmoCommands | null {
  const program = omoProgram(terminal);
  const cwd = terminal.foreground?.cwd ?? "";
  const key = listKey(terminal.address, program, cwd);
  const [state, setState] = useState<{ readonly key: string; readonly list: CommandList }>({
    key,
    list: { kind: "idle" },
  });
  const list = state.key === key ? state.list : { kind: "idle" as const };
  const want = useCallback(() => {
    if (program === null || !readsAgain(list, now(), ttlMs)) return;
    // A stale list stays shown while it is read again.
    if (list.kind !== "ready") setState({ key, list: { kind: "loading" } });
    read(exec, { machine: machineOf(terminal.address), program, cwd }).then(
      (commands) => setState((was) => (was.key === key ? { key, list: { kind: "ready", commands, at: now() } } : was)),
      () => setState((was) => (was.key === key ? { key, list: { kind: "failed" } } : was)),
    );
  }, [program, list, now, ttlMs, key, read, exec, terminal.address, cwd]);
  return program === null ? null : { list, want };
}
