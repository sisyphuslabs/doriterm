import type { Terminal } from "@doriface/protocol";
import { useCallback, useState } from "react";
import { machineOf } from "./model.ts";
import { commandCache, type ExecOn, omoProgram, type SlashCommand } from "./omo-commands.ts";

/** What the phone knows of OmO's commands: not asked yet, being read, read, or the read failed. */
export type CommandList =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly commands: readonly SlashCommand[] }
  | { readonly kind: "failed" };

export interface OmoCommands {
  readonly list: CommandList;
  /** Reads the list once it is wanted (a `/` typed), or again after a failed read; one read or being read stays. */
  readonly want: () => void;
}

const shared = commandCache();

/**
 * OmO's slash commands for a terminal that runs OmO, read from OmO on that terminal's machine the first time a `/` is
 * typed; null for any other program. `read` is the listing (cached per machine), replaceable for a test.
 */
export function useOmoCommands(exec: ExecOn, terminal: Terminal, read = shared): OmoCommands | null {
  const program = omoProgram(terminal);
  const cwd = terminal.foreground?.cwd ?? "";
  const key = `${terminal.address}\n${program ?? ""}`;
  const [state, setState] = useState<{ readonly key: string; readonly list: CommandList }>({
    key,
    list: { kind: "idle" },
  });
  const list = state.key === key ? state.list : { kind: "idle" as const };
  const asking = list.kind === "loading" || list.kind === "ready";
  const want = useCallback(() => {
    if (program === null || asking) return;
    setState({ key, list: { kind: "loading" } });
    read(exec, { machine: machineOf(terminal.address), program, cwd }).then(
      (commands) => setState((now) => (now.key === key ? { key, list: { kind: "ready", commands } } : now)),
      () => setState((now) => (now.key === key ? { key, list: { kind: "failed" } } : now)),
    );
  }, [program, asking, key, read, exec, terminal.address, cwd]);
  return program === null ? null : { list, want };
}
