import type { Terminal } from "@doriface/protocol";
import type { AgentStatus } from "@doriface/ui";
import type { Seen } from "../layout/view.ts";

/**
 * A terminal as the workspace shows it: hc's terminal, plus the marks this client adds. `offline` is a machine that
 * cannot be reached now, so hc's last picture of its terminal stays live until it is back (`withReach`); `seen` is a
 * finish this screen has already looked at (`withAttention`). hc's own state is untouched by either.
 */
export type Session = Terminal & { readonly offline?: true; readonly seen?: true };

const OSC_STATES: Readonly<Record<string, AgentStatus>> = {
  working: "working",
  blocked: "blocked",
  error: "blocked",
  done: "done",
  idle: "idle",
};

/**
 * The one status selector every surface uses (sidebar section, pane chip, tab glyph, space attention).
 * A program that never reported OSC 7501, or reported a word outside the protocol's, reads as idle; one on a machine
 * that cannot be reached reads as unknown; and a finish this screen has already been shown reads idle, since herdr-app's
 * `done` is "finished while the user wasn't looking" (#611).
 */
export function agentStatus(terminal: Session): AgentStatus {
  if (terminal.state === "finished") return terminal.seen === true ? "idle" : "done";
  if (terminal.offline === true) return "unknown";
  const word = terminal.status?.state;
  const status = word !== undefined && Object.hasOwn(OSC_STATES, word) ? (OSC_STATES[word] ?? "idle") : "idle";
  return status === "done" && terminal.seen === true ? "idle" : status;
}

/**
 * Which finish of a terminal is asking for the person, as the screen that looks at it records having seen that: the turn
 * it said `done` in, or when it finished. Null while it asks for nobody, and while its machine cannot be reached (nothing
 * of it is on screen yet). A turn rather than a flag, so the next finish asks again; a turn rather than `status_ms`, which
 * hc's status event does not carry, so a screen would read a newer finish as one it had seen.
 */
export function attentionMark(terminal: Session): string | null {
  if (terminal.offline === true) return null;
  if (terminal.state === "finished") return String(terminal.finished_ms ?? 0);
  return terminal.status?.state === "done" ? String(terminal.turn ?? 0) : null;
}

/**
 * The terminals as this screen reads them: one that finished and whose finish this screen has been shown is idle (#611).
 * Every surface reads the selector, so marking the session here reaches the tab glyph, the sidebar's groups and counts,
 * a space's attention and the phone's counts at once. Returns `terminals` itself when it has nothing to mark, so a
 * render that changed nothing keeps the array it had.
 */
export function withAttention(terminals: readonly Session[], seen: Seen): readonly Session[] {
  let marked = false;
  const shown = terminals.map((terminal): Session => {
    const mark = attentionMark(terminal);
    if (mark === null || terminal.seen === true || seen[terminal.address] !== mark) return terminal;
    marked = true;
    return { ...terminal, seen: true };
  });
  return marked ? shown : terminals;
}

/** Whether some terminal other than the one in view needs you: the next-needs-you action has somewhere to go (#1448). */
export function someoneElseNeedsYou(terminals: readonly Session[], inView: string | null): boolean {
  const next = nextNeedingYou(terminals, inView);
  return next !== null && next !== inView;
}

/** A live terminal whose agent needs the person: what "N needs you" counts and opens. */
const waitsForYou = (terminal: Session): boolean => terminal.state === "live" && agentStatus(terminal) === "blocked";

/** How many terminals other than `inView` need you: the phone session sheet's next-agent count (#1467). */
export function waitingBesides(terminals: readonly Session[], inView: string): number {
  return terminals.filter((terminal) => terminal.address !== inView && waitsForYou(terminal)).length;
}

/**
 * The terminal "N needs you" opens (#1448): walking the terminals in the core's order, the first live one that needs the
 * person after `focused`, round to the start; `focused` itself only when it is the only one. Null while nobody waits.
 */
export function nextNeedingYou(terminals: readonly Session[], focused: string | null): string | null {
  const from = focused === null ? -1 : terminals.findIndex((terminal) => terminal.address === focused);
  for (let step = 1; step <= terminals.length; step += 1) {
    const terminal = terminals[(from + step) % terminals.length];
    if (terminal !== undefined && waitsForYou(terminal)) {
      return terminal.address;
    }
  }
  return null;
}

/** A pane of the tab in view: what `panesInView` reads (a `LayoutPane` of `layout-model.ts`). */
export interface PaneShown {
  readonly id: string;
  readonly address: string | null;
}

/**
 * The terminals this screen is showing: every pane of the tab in view, or only the zoomed pane when one is zoomed, as
 * herdr-app's zoom shows that pane alone.
 */
export function panesInView(
  tab: { readonly panes: readonly PaneShown[] } | null,
  zoomed: string | null,
): readonly string[] {
  if (tab === null) return [];
  return tab.panes.flatMap((pane) =>
    pane.address === null || (zoomed !== null && pane.id !== zoomed) ? [] : [pane.address],
  );
}

/** The finishes among `addresses` that are waiting to be seen, by address: what this screen records once it shows them. */
export function marksInView(terminals: readonly Session[], addresses: readonly string[]): Seen {
  const shown = new Set(addresses);
  const marks: Record<string, string> = {};
  for (const terminal of terminals) {
    if (!shown.has(terminal.address)) continue;
    const mark = attentionMark(terminal);
    if (mark !== null) marks[terminal.address] = mark;
  }
  return marks;
}
