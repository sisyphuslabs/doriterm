import type { Agent, AgentStatus } from "@doriface/ui";
import { agentStatus } from "./attention.ts";
import { type ListedSpace, type Session, terminalTitle, toAgent } from "./model.ts";

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
    const said = lead.status?.msg ?? lead.status?.title ?? "";
    const detail = shown.length > 1 ? `${shown.length} panes` : said;
    const name = space.tabNames[at] ?? "";
    return [{ ...agent, name: name === "" ? terminalTitle(lead) : name, ...(detail === "" ? {} : { detail }) }];
  });
}

/** The space screen's subtitle: where it runs, how many tabs run, and how many of them need the person. */
export function spaceSummary(place: string, rows: readonly Agent[]): string {
  const tabs = rows.length === 0 ? "no running tabs" : `${rows.length} ${rows.length === 1 ? "tab" : "tabs"}`;
  const needs = rows.filter((row) => row.status === "blocked").length;
  return [place, tabs, ...(needs === 0 ? [] : [`${needs} needs you`])].join(" · ");
}
