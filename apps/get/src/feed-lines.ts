/** The two lines the Worker adds to a feed itself. */
export const ADDED_LINE = /^(?:stagingPercentage|minimumVersion):/;

const FILES_ITEM = /^( {2}- url: )(.*)$/;
const ITEM_FIELD = /^ {4}\S/;
const TOP_PATH = /^(path: )(.*)$/;

/**
 * Where a line of an electron-builder `latest*.yml` sits (#1981): `file` is a `files` item's `url` or the top-level
 * `path`, the only lines that name a file; `field` is another field of a `files` item; `nested` is an indented line
 * under any other top-level key, such as a multi-line `releaseNotes`, whose text is never read as a file.
 */
export type Placed =
  | { readonly at: "file"; readonly prefix: string; readonly value: string }
  | { readonly at: "top" | "field" | "nested" | "blank" };

/** Each line placed in the feed's structure, or null when the `files` list holds anything but items and their fields. */
export function placeLines(lines: readonly string[]): Placed[] | null {
  let block: "none" | "files" | "other" = "none";
  let inItem = false;
  const placed: Placed[] = [];
  for (const line of lines) {
    if (line === "") {
      placed.push({ at: "blank" });
      continue;
    }
    if (!line.startsWith(" ")) {
      block = line === "files:" ? "files" : "other";
      inItem = false;
      const path = TOP_PATH.exec(line);
      placed.push(path === null ? { at: "top" } : { at: "file", prefix: path[1] ?? "", value: path[2] ?? "" });
      continue;
    }
    if (block === "other") {
      placed.push({ at: "nested" });
      continue;
    }
    if (block === "none") return null;
    const item = FILES_ITEM.exec(line);
    if (item !== null) {
      inItem = true;
      placed.push({ at: "file", prefix: item[1] ?? "", value: item[2] ?? "" });
      continue;
    }
    if (!inItem || !ITEM_FIELD.test(line)) return null;
    placed.push({ at: "field" });
  }
  return placed;
}
