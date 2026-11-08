import type { Terminal } from "@doriface/protocol";
import { machineOf, spaceName } from "./model.ts";

/**
 * Where a palette agent lives, for the line under the list (#1465): its machine (this one named as the host), its space,
 * and the directory its foreground program is in, else the terminal's.
 */
export function agentWhere(terminal: Terminal, host: string): string {
  const machine = machineOf(terminal.address) ?? host;
  return `${machine} \u203a ${spaceName(terminal)} \u00b7 ${terminal.foreground?.cwd ?? terminal.cwd}`;
}
