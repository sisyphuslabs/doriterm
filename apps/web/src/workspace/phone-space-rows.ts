import type { Agent, AgentStatus } from "@doriface/ui";
import { agentStatus } from "./attention.ts";
import { type ListedSpace, type Session, terminalTitle, toAgent } from "./model.ts";

/** A tab as a phone names it: its own name, else the terminal it shows; never its place among its space's tabs. */
export const tabLabel = (name: string, terminal: Session): string => (name === "" ? terminalTitle(terminal) : name);

/** What a terminal said last (its status message, else its status title); empty when it said nothing. */
export const lastSaid = (terminal: Session): string => terminal.status?.msg ?? terminal.status?.title ?? "";

/**
 * A tab row's detail: what its terminal said last; with nothing said, a tab that has a name of its own still says which
 * terminal it shows (an unnamed one is already named after it). Empty when there is nothing more to say.
 */
export const rowDetail = (name: string, terminal: Session): string =>
  lastSaid(terminal) || (name === "" ? "" : terminalTitle(terminal));

/**
 * The terminal a phone moves to when the tab showing `open` closes: the tab that slides into its place among the space's
 * live tabs, else the space's last, as herdr-app's `remove_tab` picks it (afterClosing); its pane in view is its first.
 * Null when the space has no other live tab, and the phone goes up to the screen it came from instead (#1478).
 */
export function nextAfterClosing(tabs: readonly (readonly string[])[], open: string): string | null {
  const at = tabs.findIndex((panes) => panes.includes(open));
  if (at === -1) return null;
  const kept = tabs.filter((_, index) => index !== at);
  return (kept[at] ?? kept.at(-1))?.[0] ?? null;
}

/** Most urgent first: a split tab reads as the pane that most needs the person. */
const URGENCY: readonly AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];
const urgency = (terminal: Session): number => URGENCY.indexOf(agentStatus(terminal));

/**
 * A space screen's rows: one per tab that shows a live terminal, in tab order. A row is named by its tab, else by the
 * terminal it shows (never by its place: a bare "2" says nothing on a screen of its own); it reads what that terminal
 * said last, or "N panes" for a split tab, and opens the pane that most needs the person (the first when none does).
 * The space and its machine are the screen's own title, so a row repeats neither.
 */
export function spaceTabRows(space: ListedSpace, terminals: readonly Session[], nowMs: number): readonly Agent[] {
  const live = new Map(terminals.filter((each) => each.state === "live").map((each) => [each.address, each]));
  return space.tabPanes.flatMap((panes, at) => {
    const shown = panes.flatMap((address) => live.get(address) ?? []);
    const lead = shown.reduce<Session | undefined>(
      (best, each) => (best === undefined || urgency(each) < urgency(best) ? each : best),
      undefined,
    );
    if (lead === undefined) return [];
    const { detail: _where, machine: _machine, ...agent } = toAgent(lead, nowMs);
    const detail = shown.length > 1 ? `${shown.length} panes` : rowDetail(space.tabNames[at] ?? "", lead);
    return [{ ...agent, name: tabLabel(space.tabNames[at] ?? "", lead), ...(detail === "" ? {} : { detail }) }];
  });
}

/** The space screen's subtitle: where it runs, how many tabs run, and how many of them need the person. */
export function spaceSummary(place: string, rows: readonly Agent[]): string {
  const tabs = rows.length === 0 ? "no running tabs" : `${rows.length} ${rows.length === 1 ? "tab" : "tabs"}`;
  const needs = rows.filter((row) => row.status === "blocked").length;
  return [place, tabs, ...(needs === 0 ? [] : [`${needs} ${needs === 1 ? "needs" : "need"} you`])].join(" · ");
}
