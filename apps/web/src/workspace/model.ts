import type { JsonObject, Terminal } from "@doriface/protocol";
import { docSpaces, panesOf, tabsOf } from "@doriface/protocol/layout";
import type { Agent, AgentStatus, Space } from "@doriface/ui";
import { spaceKey } from "../layout/view.ts";
import { isOpeningName } from "../terminal/opening-attach.ts";
import { agentStatus } from "./attention.ts";
import type { Session } from "./attention.ts";
import { type GitFactsOf, shownGit } from "./git-facts.ts";
import { TITLE_LABEL } from "./session-actions.ts";

/** The workspace's session is the one `attention.ts` reads, with this client's `offline` and `seen` marks on it. */
export type { Session };

/** The shells herdr-app reads as a prompt rather than a program (its `defaults/programs.json` `shells`). */
const SHELLS: ReadonlySet<string> = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
  "elvish",
  "xonsh",
  "tcsh",
  "csh",
  "ksh",
  "ion",
]);

/** `/bin/zsh`, a login shell's `-zsh` and `cmd.exe` as the bare program name. */
const programName = (path: string): string =>
  (path.split(/[/\\]/).at(-1) ?? path).replace(/^-+/, "").replace(/\.exe$/i, "");

/**
 * What runs in a terminal, as herdr-app's tab strip draws its icon: an agent (one that reports its state over OSC 7501),
 * a shell at its prompt, or another program in front of the shell.
 */
export function programKind(terminal: Session): "agent" | "shell" | "program" {
  if (terminal.status?.state !== undefined) return "agent";
  const front = terminal.foreground?.argv[0] ?? terminal.foreground?.name ?? terminal.argv[0] ?? "";
  return SHELLS.has(programName(front)) ? "shell" : "program";
}

/**
 * Whether closing would stop a program at work, as herdr-app's `busy` reads it: an agent in its turn, or a program in
 * front of the shell. A shell at its prompt and an agent between turns are not.
 */
export function runsProgram(terminal: Session): boolean {
  if (terminal.state !== "live") return false;
  if (terminal.status?.state !== undefined) return agentStatus(terminal) === "working";
  const front = terminal.foreground?.argv[0] ?? terminal.foreground?.name ?? terminal.argv[0] ?? "";
  return !SHELLS.has(programName(front));
}

/**
 * Whether closing these sessions asks first, by the terminal config's `confirm-close-surface` (as Ghostty reads it):
 * `false` never, `always` every time, anything else while one of them runs a program.
 */
export function asksBeforeClosing(confirm: string, sessions: readonly Session[]): boolean {
  if (confirm === "false") return false;
  return confirm === "always" || sessions.some(runsProgram);
}

export function terminalTitle(terminal: Terminal): string {
  const renamed = terminal.labels[TITLE_LABEL];
  if (renamed !== undefined && renamed !== "") return renamed;
  // A name this page gave only so the attach could go with the run is no title (#1351).
  const named = isOpeningName(terminal.name) ? terminal.title : (terminal.name ?? terminal.title);
  if (named !== undefined && named !== null && named !== "") return named;
  return terminal.foreground?.name ?? terminal.argv[0] ?? terminal.address;
}

/**
 * A tab's title as herdr-app's strip reads it (#466 ruling A): its own name, else its place in its space counted from 1.
 * It does not follow the pane in focus; the desktop strip and the phone's header both read it.
 */
export function tabTitle(name: string, position: number): string {
  return name !== "" ? name : String(position + 1);
}

export function machineOf(address: string): string | undefined {
  const slash = address.indexOf("/");
  return slash === -1 ? undefined : address.slice(0, slash);
}

/** A machine's id: `local` for this one, `machine:<name>` for an added one, unique even when the names match. */
export const idOfMachine = (name: string | undefined): string => (name === undefined ? "local" : `machine:${name}`);

/** The id of the machine an address is on: this one for a bare `t7`, the named machine for `machine/t7`. */
export const machineId = (address: string): string => idOfMachine(machineOf(address));

function basename(path: string): string {
  return path.split("/").findLast((part) => part !== "") ?? "/";
}

/**
 * The hc label that names a terminal's space. A loose terminal carrying it is adopted into the space of that name, and a
 * rename writes it on the space's live terminals too, so hc and the layout document agree (#395, #404).
 */
export const SPACE_LABEL = "space";

/** A space is the `space` label, else the working directory's last segment. */
export function spaceName(terminal: Terminal): string {
  return terminal.labels[SPACE_LABEL] ?? basename(terminal.foreground?.cwd ?? terminal.cwd);
}

const spaceDir = (terminal: Terminal): string => terminal.foreground?.cwd ?? terminal.cwd;

/** The parent directory's name, to tell apart two spaces whose directories end the same way; the whole path at the root. */
function parentName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length >= 2 ? (parts.at(-2) ?? path) : path;
}

/** "<1m", "6m", "2h", "3d" since a moment, for agent rows. */
export function formatAge(sinceMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - sinceMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Every live terminal as a row: its reported state, what it said, where it runs and since when. */
export function toAgent(terminal: Terminal, nowMs: number): Agent {
  const machine = machineOf(terminal.address);
  const said = terminal.status?.msg ?? terminal.status?.title;
  const detail = said === undefined || said === "" ? spaceName(terminal) : said;
  const agent: Agent = {
    id: terminal.address,
    name: terminalTitle(terminal),
    status: agentStatus(terminal),
    detail,
    age: formatAge(terminal.status_ms ?? terminal.created_ms, nowMs),
  };
  return machine === undefined ? agent : Object.assign(agent, { machine });
}

export interface AgentGroups {
  readonly blocked: readonly Agent[];
  readonly done: readonly Agent[];
  readonly working: readonly Agent[];
  readonly idle: readonly Agent[];
  /** On a machine that cannot be reached: their state is unknown until it is back. */
  readonly offline: readonly Agent[];
}

/** Needs you, Done, Working, Idle, then Offline; programs that never reported sit with Idle. */
export function groupAgents(terminals: readonly Session[], nowMs: number): AgentGroups {
  const groups = { blocked: [] as Agent[], done: [] as Agent[], working: [] as Agent[], idle: [] as Agent[] };
  const offline: Agent[] = [];
  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    if (terminal.offline === true) {
      offline.push(toAgent(terminal, nowMs));
      continue;
    }
    const agent = toAgent(terminal, nowMs);
    if (agent.status !== "unknown") groups[agent.status].push(agent);
  }
  return { ...groups, offline };
}

const ATTENTION: readonly AgentStatus[] = ["blocked", "working", "done"];

const remoteRank = (machine: string | undefined): number => (machine === undefined ? 0 : 1);

/** Names in the order a person reads them: numbers by value, so box9 comes before box10. */
export const byName = new Intl.Collator(undefined, { numeric: true });

/** One machine's layout document as the spaces list reads it. */
export interface SpacesSource {
  readonly machine: string | null;
  readonly machineId: string | null;
  readonly doc: JsonObject | null;
}

/** A space of a layout document, with the terminals its tabs show (live or not), in tab order. */
/** `dir`: where the space is, its folder, else its first live terminal's directory; empty when neither is known. */
export type ListedSpace = Space & {
  readonly addresses: readonly string[];
  /** Each tab once, in tab order, with its panes' addresses (live or not), so a split tab counts as one. */
  readonly tabPanes: readonly (readonly string[])[];
  /** Each tab's own name, as saved (empty when unnamed), in the order of `tabPanes`. */
  readonly tabNames: readonly string[];
  readonly dir: string;
};

/**
 * The spaces as herdr-app lists them (#404): every space of every machine's layout document, this machine's first, then
 * each machine's in name order, each machine's in its document's order. A space is keyed by `spaceKey` and counts its
 * tabs; it is named as saved, else after its folder, else after where its first live terminal is, and two of one machine
 * that would read the same are told apart by the parent directory, as toSpaces does (#397).
 */
export function layoutSpaces(
  sources: readonly SpacesSource[],
  terminals: readonly Session[],
  gitOf?: GitFactsOf,
): ListedSpace[] {
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  const ordered = sources.toSorted(
    (a, b) =>
      remoteRank(a.machine ?? undefined) - remoteRank(b.machine ?? undefined) ||
      byName.compare(a.machine ?? "", b.machine ?? ""),
  );
  const entries = ordered.flatMap((source) => {
    const { doc } = source;
    if (doc === null) return [];
    const tabs = tabsOf(doc);
    return docSpaces(doc).map((space) => {
      const own = tabs.filter((tab) => tab.space === space.id);
      const tabNames = own.map((tab) => tab.name);
      const tabPanes = own.map((tab) =>
        panesOf(tab.root).flatMap((pane) =>
          pane.terminal === null
            ? []
            : [source.machine === null ? pane.terminal : `${source.machine}/${pane.terminal}`],
        ),
      );
      const addresses = tabPanes.flat();
      const live = addresses.flatMap((address) => {
        const terminal = byAddress.get(address);
        return terminal?.state === "live" ? [terminal] : [];
      });
      const first = live[0];
      const dir = space.folder !== "" ? space.folder : first === undefined ? "" : spaceDir(first);
      return {
        key: spaceKey(source.machineId, space.id),
        machine: source.machine ?? undefined,
        name: space.name !== "" ? space.name : dir === "" ? "Space" : basename(dir),
        labeled: space.name !== "",
        dir,
        tabs: space.tabs.length,
        addresses,
        tabPanes,
        tabNames,
        statuses: new Set(live.map(agentStatus)),
      };
    });
  });
  return entries.map((entry) => {
    const twin = entries.some(
      (other) => other.key !== entry.key && other.machine === entry.machine && other.name === entry.name,
    );
    const name = twin && !entry.labeled && entry.dir !== "" ? `${entry.name} · ${parentName(entry.dir)}` : entry.name;
    const space: ListedSpace = {
      id: entry.key,
      name,
      tabs: entry.tabs,
      addresses: entry.addresses,
      tabPanes: entry.tabPanes,
      tabNames: entry.tabNames,
      dir: entry.dir,
    };
    if (entry.machine !== undefined) Object.assign(space, { machine: entry.machine });
    const attention = ATTENTION.find((status) => entry.statuses.has(status));
    if (attention !== undefined) Object.assign(space, { attention });
    const git = entry.dir === "" ? undefined : shownGit(gitOf?.(entry.machine, entry.dir));
    if (git !== undefined) Object.assign(space, { git });
    return space;
  });
}

/** A tab's place among its space's tabs that show a live terminal, counted from 1 in tab order; a split tab is one. */
export interface TabPosition {
  readonly index: number;
  readonly count: number;
}

/**
 * The live terminals each tab of a space shows, in tab order; a tab with none is left out. The phone's sheet lists one
 * row per entry, the one its first live pane stands for.
 */
export function liveTabs(space: ListedSpace, terminals: readonly Terminal[]): readonly (readonly string[])[] {
  const liveAt = new Set(terminals.filter((t) => t.state === "live").map((t) => t.address));
  return space.tabPanes
    .map((panes) => panes.filter((address) => liveAt.has(address)))
    .filter((panes) => panes.length > 0);
}

/** Where a terminal sits in the listed space whose tabs show it; none when it is finished or in no space's tab. */
export function tabPosition(
  spaces: readonly ListedSpace[],
  terminals: readonly Terminal[],
  address: string,
): TabPosition | undefined {
  const space = spaces.find((each) => each.addresses.includes(address));
  if (space === undefined) return undefined;
  const live = liveTabs(space, terminals);
  const index = live.findIndex((panes) => panes.includes(address));
  return index === -1 ? undefined : { index: index + 1, count: live.length };
}
