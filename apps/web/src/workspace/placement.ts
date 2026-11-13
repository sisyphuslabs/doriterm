import type { JsonObject, Terminal } from "@doriface/protocol";
import { docSpaces, type NewSpace } from "@doriface/protocol/layout";
import { SPACE_LABEL } from "./model.ts";

/** The label herdr-app places a terminal by: the id of a space in its machine's layout document. */
export const HERDR_SPACE_LABEL = "herdr.space";

/** The space adopted terminals with no space of their own go to, as herdr-app names its fallback. */
export const HOME_SPACE = "Home";

/** Whether a space's folder holds the directory: the folder itself, or one inside it. */
const holds = (folder: string, dir: string): boolean =>
  folder !== "" && (dir === folder || dir.startsWith(folder.endsWith("/") ? folder : `${folder}/`));

/**
 * The space a terminal no tab shows goes to, in its machine's document (#404): the space its `herdr.space` label names
 * when the document has it, as herdr-app adopts; else the space its `space` label names (made when there is none);
 * else the space whose folder holds its working directory (the deepest such folder); else the Home space, made when
 * there is none. `makeId` is called only when a new space is made, so callers that number ids keep their order.
 */
export function placeOf(doc: JsonObject | null, terminal: Terminal, makeId: (prefix: "spc") => string): NewSpace {
  const spaces = doc === null ? [] : docSpaces(doc);
  const byId = terminal.labels[HERDR_SPACE_LABEL] ?? "";
  const labelled = byId === "" ? undefined : spaces.find((space) => space.id === byId);
  if (labelled !== undefined) return { id: labelled.id, folder: labelled.folder };
  const label = terminal.labels[SPACE_LABEL] ?? "";
  if (label !== "") {
    const named = spaces.find((space) => space.name === label);
    return { id: named?.id ?? makeId("spc"), folder: named?.folder ?? "", name: label };
  }
  const dir = terminal.foreground?.cwd ?? terminal.cwd;
  const owner = spaces
    .filter((space) => holds(space.folder, dir))
    .toSorted((a, b) => b.folder.length - a.folder.length)[0];
  if (owner !== undefined) return { id: owner.id, folder: owner.folder };
  const home = spaces.find((space) => space.name === HOME_SPACE && space.folder === "");
  return { id: home?.id ?? makeId("spc"), folder: "", name: HOME_SPACE };
}

/**
 * What a new tab does with the transient tab in view (`keepTransient`'s answer): a tab its terminal's labels place never
 * takes the transient tab with it (#2468), so that one keeps a space of its own ("apart") instead of riding along.
 */
export function placedFate(transient: "with-new" | "apart" | null, placed: boolean): "with-new" | "apart" | null {
  return placed && transient !== null ? "apart" : transient;
}

/**
 * The tab a new tab goes after: the one in view (`near`) only when the space the write landed in is the space guessed
 * before it; a space another client made meanwhile, or one the write itself made, takes the tab at its end (#2468).
 */
export function afterIn(landed: string, guessed: string, near: string | undefined): string | undefined {
  return landed === guessed ? near : undefined;
}
