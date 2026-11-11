import type { Terminal } from "@doriface/protocol";

/**
 * Where a terminal's prompt card stands: up, its screen still being read for one (#192 reads Claude Code's and Codex's
 * dialogs), or none coming.
 */
export type CardState = "shown" | "reading" | "none";

/**
 * A live agent blocked on a person with no card up (#1527, #1555): a plain "continue?", a menu, a confirm, an agent this
 * client cannot read, or a Claude Code or Codex screen its reader found no dialog on. It is answered with the agent's own
 * keys, one tap each. While a card may still come from the screen being read, nothing shows, so the strip never flashes
 * ahead of the card.
 */
export function waitsOnKeys(terminal: Terminal, card: CardState): boolean {
  return terminal.state === "live" && terminal.status?.state === "blocked" && card === "none";
}

/** What the pane's polite live region says as the strip appears. */
export const WAITING_ANNOUNCEMENT = "The agent is waiting for input. Enter, Escape and the arrow keys answer it.";

/** The keys offered, in the order a person answers with them: accept, back out, then move a menu's cursor. */
export const WAITING_KEYS = [
  { key: "enter", label: "Enter", name: "Enter" },
  { key: "esc", label: "Esc", name: "Escape" },
  { key: "up", label: "↑", name: "Arrow up" },
  { key: "down", label: "↓", name: "Arrow down" },
] as const;

/**
 * Reports whether the latest press failed (#1555): each press clears the failure, and a press that settles after a later
 * one was made says nothing, so a failure never stays up over a press that went through.
 */
export function latestPress(onFailed: (failed: boolean) => void): (send: () => Promise<unknown>) => void {
  let latest = 0;
  return (send) => {
    const press = ++latest;
    onFailed(false);
    send().then(
      () => undefined,
      () => {
        if (press === latest) onFailed(true);
      },
    );
  };
}
