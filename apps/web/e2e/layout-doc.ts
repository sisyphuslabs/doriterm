// The herdr-app layout document on the e2e core, written the way herdr-app 0.1.12 writes it: keys sorted, `type` on
// every node, a tab's root a row whose id is the tab's.
import type { Locator, Page } from "@playwright/test";
import { getCoreDoc, setCoreDoc, updateCoreDoc } from "./core-doc.ts";
import { LAYOUT_MACHINE_SPEC } from "./layout-seed.ts";
import { MACHINE_NAME } from "./machine.ts";

export const LAYOUT_DOC = "herdr-app";
/** doriface's own document of pinned tab ids beside the layout (#1561); herdr-app drops unknown tab fields. */
export const PINS_DOC = "doriface-pins";

export type Tree =
  | { readonly pane: string; readonly terminal: string; readonly weight?: number }
  | {
      readonly id: string;
      readonly axis: "row" | "column";
      readonly children: readonly Tree[];
      readonly weight?: number;
    };

const sized = (node: Record<string, unknown>, weight: number | undefined): Record<string, unknown> =>
  weight === undefined ? node : { ...node, size: { weight } };

export function treeNode(tree: Tree): Record<string, unknown> {
  if ("pane" in tree) {
    return sized({ content: { terminal: tree.terminal }, id: tree.pane, type: "block" }, tree.weight);
  }
  return sized({ children: tree.children.map(treeNode), id: tree.id, type: tree.axis }, tree.weight);
}

export interface SeedTab {
  readonly id: string;
  readonly name?: string;
  readonly root: readonly Tree[];
}

/** Saves these tabs as the core's layout, or (`on`) as its added machine's. */
export function seedLayout(tabs: readonly SeedTab[], folder = "/tmp", on?: string): void {
  setCoreDoc(
    LAYOUT_DOC,
    {
      spaces: [
        {
          folder,
          id: "spc-e2e",
          name: "",
          tabs: tabs.map((tab) => ({
            id: tab.id,
            name: tab.name ?? "",
            root: { children: tab.root.map(treeNode), id: tab.id, type: "row" },
          })),
        },
      ],
    },
    on,
  );
}

export interface SeedSpace {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  /** One tab per terminal: on this core its address, on an added machine (`on`) its local one there (`tN`). */
  readonly tabs: readonly {
    readonly id: string;
    readonly name: string;
    readonly terminal: string;
    /** More terminals split beside the first, in one row. */
    readonly beside?: readonly string[];
    /** Pinned in front of the space's other tabs (#1561). */
    readonly pinned?: boolean;
  }[];
}

/**
 * Saves these spaces, each tab one pane, as the core's layout or (`on`) as its added machine's (#404), and their pinned
 * tabs as its pins document (none left from an earlier seed).
 */
export function seedSpaces(spaces: readonly SeedSpace[], on?: string): void {
  setCoreDoc(
    LAYOUT_DOC,
    {
      spaces: spaces.map((space) => ({
        folder: space.folder,
        id: space.id,
        name: space.name,
        tabs: space.tabs.map((tab) => ({
          id: tab.id,
          name: tab.name,
          root: {
            children: [tab.terminal, ...(tab.beside ?? [])].map((terminal, at) =>
              treeNode({ pane: at === 0 ? `p-${tab.id}` : `p-${tab.id}-${at}`, terminal }),
            ),
            id: tab.id,
            type: "row",
          },
        })),
      })),
    },
    on,
  );
  const pinned = spaces.flatMap((space) => space.tabs.flatMap((tab) => (tab.pinned === true ? [tab.id] : [])));
  setCoreDoc(PINS_DOC, pinned.length === 0 ? null : { pinned_tabs: pinned }, on);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** A saved tree as `id@weight(children)`, so a spec reads the shape and the sizes it keeps in one line. */
function outline(node: unknown): string {
  if (!isRecord(node)) return "?";
  const size = node["size"];
  const weight = isRecord(size) && typeof size["weight"] === "number" ? `@${size["weight"]}` : "";
  const children = listOf(node["children"]);
  return `${String(node["id"])}${weight}${children.length === 0 ? "" : `(${children.map(outline).join(",")})`}`;
}

/** The saved tab's tree in the core's layout document, as `outline` writes it, or null when no tab has that id. */
export function savedTab(id: string): string | null {
  const doc = getCoreDoc(LAYOUT_DOC);
  const spaces = isRecord(doc) ? listOf(doc["spaces"]) : [];
  const tab = spaces
    .flatMap((space) => (isRecord(space) ? listOf(space["tabs"]) : []))
    .find((each) => isRecord(each) && each["id"] === id);
  return isRecord(tab) ? outline(tab["root"]) : null;
}

/** Renames a saved tab as another device would: once the page shows the name, it has read every earlier write. */
export function renameTab(id: string, name: string): void {
  const renamed = (tab: unknown): unknown =>
    isRecord(tab) && tab["id"] === id ? Object.assign({}, tab, { name }) : tab;
  const inSpace = (space: unknown): unknown =>
    isRecord(space) ? Object.assign({}, space, { tabs: listOf(space["tabs"]).map(renamed) }) : space;
  // The new document is derived from the one on the core, so a lost compare-and-set renames the tab in the document the core
  // reports at that attempt instead of restoring a copy read before another client's write landed (#896).
  updateCoreDoc(LAYOUT_DOC, (current) => {
    if (!isRecord(current)) throw new Error("no layout document to rename a tab in");
    return { ...current, spaces: listOf(current["spaces"]).map(inSpace) };
  });
}

export function clearLayout(): void {
  setCoreDoc(LAYOUT_DOC, null);
}

/**
 * Every spec starts with no tabs saved on its worker's e2e core and on that core's added machine, as each started before
 * the layout lived in the core. A machine that is not connected shows a fresh page no layout, so there is nothing to
 * clear on it.
 */
export function clearLayouts(): void {
  clearLayout();
  clearOn(MACHINE_NAME, "host");
}

/**
 * The same on the layout host and its added machine. The workers share that host, so only the spec that reads it clears
 * it: cleared from every spec, the workers' writes race on its documents' versions and wipe the layout spec's tabs.
 */
export function clearLayoutHost(): void {
  setCoreDoc(LAYOUT_DOC, null, undefined, "layout");
  clearOn(LAYOUT_MACHINE_SPEC.name, "layout");
}

function clearOn(machine: string, core: "host" | "layout"): void {
  try {
    setCoreDoc(LAYOUT_DOC, null, machine, core);
  } catch (error) {
    if (!/"kind":"(unavailable|machine_unknown|needs_login)"/.test(String(error))) throw error;
  }
}

export const paneOf = (page: Page, address: string): Locator =>
  page.locator("section", { has: page.locator(`[data-terminal="${address}"]`) });

const round = (value: number): number => Math.round(value * 100) / 100;

export interface Fraction {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A pane's box as fractions of the selected tab's panel, so the check holds at any window size. */
export async function fractionOf(page: Page, address: string): Promise<Fraction> {
  const panel = page.locator('[role="tabpanel"]:visible');
  const [outer, inner] = [await panel.boundingBox(), await paneOf(page, address).boundingBox()];
  if (outer === null || inner === null) throw new Error(`no box for ${address} or its tab panel`);
  return {
    x: round((inner.x - outer.x) / outer.width),
    y: round((inner.y - outer.y) / outer.height),
    w: round(inner.width / outer.width),
    h: round(inner.height / outer.height),
  };
}
