import { hasPromptReader, type Terminal } from "@doriface/protocol";

/**
 * A live agent blocked on something it has no card for here (#1527): a plain "continue?", a menu, a confirm, or an agent
 * this client cannot read. It is answered with the agent's own keys, one tap each; Claude Code and Codex keep #192's card.
 */
export function waitsOnKeys(terminal: Terminal): boolean {
  const status = terminal.status;
  return terminal.state === "live" && status?.state === "blocked" && !hasPromptReader(status.app ?? "");
}

/** The keys offered, in the order a person answers with them: accept, back out, then move a menu's cursor. */
export const WAITING_KEYS = [
  { key: "enter", label: "Enter", name: "Enter" },
  { key: "esc", label: "Esc", name: "Escape" },
  { key: "up", label: "↑", name: "Arrow up" },
  { key: "down", label: "↓", name: "Arrow down" },
] as const;
