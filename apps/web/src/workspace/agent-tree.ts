import type { AgentStatus, AgentTreeGuide } from "@doriface/ui";
import { BY_ADDRESS } from "./adoption.ts";
import { agentStatus, type Session } from "./attention.ts";

/**
 * The deepest a row is nested. hc never makes a chain this deep in use; a deeper one, or a feed gone wrong, goes on as
 * a top-level row from here, so it is drawn rather than lost. The views draw fewer levels still (#2746).
 */
export const MAX_TREE_DEPTH = 16;

/** The sections' own order (Needs you, Working, Idle, Done, Offline): what a parent's urgency is ranked by. */
export const STATUS_RANK: Readonly<Record<AgentStatus, number>> = {
  blocked: 0,
  working: 1,
  idle: 2,
  done: 3,
  unknown: 4,
};

export interface TreeRow {
  readonly address: string;
  /** 0 for a top-level row. */
  readonly depth: number;
  /** One cell per level above this row: "│" a continuing ancestor, "├" / "└" this row's own joint, "" a spent one. */
  readonly guides: readonly AgentTreeGuide[];
  /** Live descendants, the whole subtree, not just the children. */
  readonly descendants: number;
  /** The most urgent of this row and its live descendants; its own status for a leaf. */
  readonly urgency: AgentStatus;
}

/**
 * A parent as the feed's core names it, an address like the terminals' own: bare on this machine, `box/t3` on an added
 * one, wherever the child runs. The core rewrites what the child's machine recorded, so a child on `box` started from
 * this machine's `t3` reads `t3` (#2779).
 */
function parentAddress(terminal: Session): string | null {
  const parent = terminal.parent ?? null;
  return parent === "" ? null : parent;
}

/** Each listed terminal's parent where that parent is listed too and the chain above it does not come back to it. */
function parentsOf(terminals: readonly Session[]): ReadonlyMap<string, string> {
  const listed = new Set(terminals.map((terminal) => terminal.address));
  const raw = new Map<string, string>();
  for (const terminal of terminals) {
    const parent = parentAddress(terminal);
    if (parent !== null && listed.has(parent)) raw.set(terminal.address, parent);
  }
  const parents = new Map<string, string>();
  for (const [child, parent] of raw) {
    const seen = new Set<string>();
    let at: string | undefined = parent;
    while (at !== undefined && at !== child && !seen.has(at)) {
      seen.add(at);
      at = raw.get(at);
    }
    if (at !== child) parents.set(child, parent);
  }
  return parents;
}

/**
 * Guides and descendant counts from the depths of rows drawn depth first, so a list that dropped rows (a filter, a
 * pinned subtree lifted out) draws its own shape.
 */
export function treeShape(depths: readonly number[]): {
  readonly guides: readonly (readonly AgentTreeGuide[])[];
  readonly descendants: readonly number[];
} {
  const guides: AgentTreeGuide[][] = [];
  const descendants: number[] = [];
  const later: boolean[] = [];
  for (let index = depths.length - 1; index >= 0; index -= 1) {
    const depth = depths[index] ?? 0;
    const cells: AgentTreeGuide[] = [];
    for (let level = 1; level < depth; level += 1) cells.push(later[level] === true ? "│" : "");
    if (depth > 0) cells.push(later[depth] === true ? "├" : "└");
    guides[index] = cells;
    later[depth] = true;
    later.length = depth + 1;
    let count = 0;
    while ((depths[index + 1 + count] ?? -1) > depth) count += 1;
    descendants[index] = count;
  }
  return { guides, descendants };
}

/**
 * Every live terminal exactly once, depth first, each with its place in the tree: a child under the listed terminal
 * hc says started it (`parent`), children in start order. A child whose parent is not listed, a self-parent and a cycle
 * are top-level rows. `statusOf` is the status a row is placed by, its own and before bubbling; a child's `done` reads as
 * idle for its parent, so a helper finishing does not pull a working parent out of Working, and an offline descendant
 * never bubbles. A row `apart` (one listed in another section than its parent, such as a pinned one) lends its urgency
 * to nobody above it; one inside a row already apart is listed with it and bubbles as usual.
 */
export function agentTree(
  terminals: readonly Session[],
  statusOf: (terminal: Session) => AgentStatus = agentStatus,
  apart: (terminal: Session) => boolean = () => false,
): readonly TreeRow[] {
  const live = terminals.filter((terminal) => terminal.state === "live");
  const parents = parentsOf(live);
  const children = new Map<string, Session[]>();
  for (const terminal of live) {
    const parent = parents.get(terminal.address);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), terminal]);
  }
  for (const list of children.values())
    list.sort((a, b) => a.created_ms - b.created_ms || BY_ADDRESS.compare(a.address, b.address));
  const roots = live.filter((terminal) => !parents.has(terminal.address));
  const flat: { readonly terminal: Session; readonly depth: number; readonly cut: boolean }[] = [];
  const visit = (terminal: Session, depth: number, inside: boolean): void => {
    if (depth > MAX_TREE_DEPTH) {
      roots.push(terminal);
      return;
    }
    const own = apart(terminal);
    flat.push({ terminal, depth, cut: depth > 0 && own && !inside });
    for (const child of children.get(terminal.address) ?? []) visit(child, depth + 1, inside || own);
  };
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    if (root !== undefined) visit(root, 0, false);
  }
  const { guides, descendants } = treeShape(flat.map((row) => row.depth));
  const urgency: AgentStatus[] = [];
  for (let index = flat.length - 1; index >= 0; index -= 1) {
    const { terminal, depth } = flat[index] ?? { terminal: undefined, depth: 0 };
    const own = terminal === undefined ? "unknown" : statusOf(terminal);
    let best = own;
    const last = index + (descendants[index] ?? 0);
    for (let below = index + 1; below <= last; below += 1) {
      const row = flat[below];
      if (row === undefined || row.depth !== depth + 1 || row.cut) continue;
      const kid = urgency[below] ?? "unknown";
      const read = kid === "done" ? "idle" : kid;
      if (read !== "unknown" && (best === "unknown" || STATUS_RANK[read] < STATUS_RANK[best])) best = read;
    }
    urgency[index] = best;
  }
  return flat.map((row, index) => ({
    address: row.terminal.address,
    depth: row.depth,
    guides: guides[index] ?? [],
    descendants: descendants[index] ?? 0,
    urgency: urgency[index] ?? "unknown",
  }));
}

interface Shaped {
  readonly depth?: number;
  readonly guides?: readonly AgentTreeGuide[];
  readonly descendants?: number;
}

/**
 * The rows with the guides and descendant counts their own list gives them (`treeShape`). A row whose shape is already
 * right stays the same object, so a list that lost nothing is drawn as it was.
 */
export function withShape<Row extends Shaped>(rows: readonly Row[]): readonly Row[] {
  const { guides, descendants } = treeShape(rows.map((row) => row.depth ?? 0));
  return rows.map((row, index) => {
    const cells = guides[index] ?? [];
    const count = descendants[index] ?? 0;
    return (row.guides ?? []).join() === cells.join() && (row.descendants ?? 0) === count
      ? row
      : Object.assign({}, row, { guides: cells, descendants: count });
  });
}

/** What a folded row hides: how many sub-agents, how many of them need the person, and the most urgent of them. */
export interface Hidden {
  readonly count: number;
  readonly blocked: number;
  /** As a parent reads its sub-agents: a done one counts as idle, an offline one not at all; idle when none is live. */
  readonly urgency: AgentStatus;
}

/** The sub-agents under the row at `index` of a depth-first list, summed up for the fold control that hides them. */
export function hiddenUnder(
  rows: readonly { readonly depth?: number; readonly status: AgentStatus }[],
  index: number,
): Hidden {
  const depth = rows[index]?.depth ?? 0;
  let count = 0;
  let blocked = 0;
  let urgency: AgentStatus = "idle";
  for (let at = index + 1; (rows[at]?.depth ?? 0) > depth && at < rows.length; at += 1) {
    const status = rows[at]?.status ?? "unknown";
    count += 1;
    if (status === "blocked") blocked += 1;
    const read = status === "done" ? "idle" : status;
    if (read !== "unknown" && STATUS_RANK[read] < STATUS_RANK[urgency]) urgency = read;
  }
  return { count, blocked, urgency };
}

/** The ids of the rows above `index` in a depth-first list, nearest first. */
export function ancestorsOf(
  rows: readonly { readonly id: string; readonly depth?: number }[],
  index: number,
): string[] {
  const found: string[] = [];
  let depth = rows[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0 && depth > 0; at -= 1) {
    const row = rows[at];
    if (row !== undefined && (row.depth ?? 0) < depth) {
      found.push(row.id);
      depth = row.depth ?? 0;
    }
  }
  return found;
}

/**
 * The rows with each folded row's subtree left out, the folded row itself kept. The selected row's ancestors are drawn
 * open, so opening an agent from anywhere never leaves it hidden; the fold the person set comes back once it is not.
 * Gives back `rows` itself when nothing is folded away.
 */
export function foldRows<Row extends { readonly id: string; readonly depth?: number }>(
  rows: readonly Row[],
  folded: ReadonlySet<string>,
  selected: string | null,
): readonly Row[] {
  if (folded.size === 0) return rows;
  const at = selected === null ? -1 : rows.findIndex((row) => row.id === selected);
  const open = new Set(at === -1 ? [] : ancestorsOf(rows, at));
  const shown: Row[] = [];
  let hideBelow: number | null = null;
  for (const row of rows) {
    const depth = row.depth ?? 0;
    if (hideBelow !== null && depth > hideBelow) continue;
    hideBelow = folded.has(row.id) && !open.has(row.id) ? depth : null;
    shown.push(row);
  }
  return shown.length === rows.length ? rows : shown;
}
