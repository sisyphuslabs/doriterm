import { folderSpaceName, type JsonObject, programSpaceName, SPACE_LABEL, type Terminal } from "@doriface/protocol";
import { docSpaces, type NewSpace } from "@doriface/protocol/layout";

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
 * else the space whose folder holds its working directory (the deepest such folder); else a space named after the work
 * the terminal does (#2670) — its directory when that names a task, the space keeping that folder, so the terminal's
 * later siblings join it, and saving no name, so the sidebar names it after the folder and tells two folders ending the
 * same way apart by their parent (#397); else, from a system directory, a folderless space named after the program it started — never
 * a generic Home, which only an existing Home space (herdr-app's own fallback) still adopts. `makeId` is called only
 * when a new space is made, so callers that number ids keep their order.
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
  if (home !== undefined) return { id: home.id, folder: "" };
  const task = folderSpaceName(dir);
  if (task !== undefined) return { id: makeId("spc"), folder: dir };
  const program = programSpaceName(terminal.argv[0]);
  const named = spaces.find((space) => space.folder === "" && space.name === program);
  return { id: named?.id ?? makeId("spc"), folder: "", name: program };
}

/**
 * The space a placed tab is guessed to land in before its write: an existing space keeps its id, and a space the write
 * would make gets the empty id, which no real space has, so the guess never matches a space the write itself makes.
 */
export function guessedSpace(
  placed: ((doc: JsonObject | null, makeId: (prefix: "spc") => string) => NewSpace) | undefined,
  doc: JsonObject | null,
): NewSpace | undefined {
  return placed?.(doc, () => "");
}
