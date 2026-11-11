/** The two lines the Worker adds to a feed itself. */
export const ADDED_LINE = /^(?:stagingPercentage|minimumVersion):/;

const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9]*:(?:\s|$)/;
const FILES_KEY = /^files:/;
const FILES_HEADER = /^files:\s*$/;
const BLOCK_SCALAR = /:\s*[|>][-+0-9]*\s*$/;
const FILES_ITEM = /^( {2}- url: )(.*)$/;
const ITEM_FIELD = /^ {4}\S/;
const TOP_PATH = /^(path: )(.*)$/;
const FILE_KEY = /^\s*(?:- )?["']?(?:url|path)["']?\s*:/;

/**
 * Where a line of an electron-builder `latest*.yml` sits (#1981): `file` is a `files` item's `url` or the top-level
 * `path`, the only lines that name a file; `field` is another field of a `files` item; `nested` is a line of a block
 * scalar such as `releaseNotes: |`, whose text is never read as a file.
 */
export type Placed =
  | { readonly at: "file"; readonly prefix: string; readonly value: string }
  | { readonly at: "top" | "field" | "nested" | "blank" };

/**
 * Each line placed in the feed's structure, or null for any structure electron-builder does not write, since a YAML
 * parser could still read a file from it: a top-level line that is not a plain `key:` (a list item, or a key quoted,
 * escaped, tagged, anchored or explicit), `files` with a value on its line, an indented line under a key that is neither
 * `files:` nor a block scalar, or a `url` or `path` key anywhere else.
 */
export function placeLines(lines: readonly string[]): Placed[] | null {
  let block: "none" | "files" | "scalar" | "plain" = "none";
  let inItem = false;
  const placed: Placed[] = [];
  for (const line of lines) {
    if (line === "") {
      placed.push({ at: "blank" });
      continue;
    }
    if (!/^\s/.test(line)) {
      if (!PLAIN_KEY.test(line)) return null;
      if (FILES_KEY.test(line) && !FILES_HEADER.test(line)) return null;
      block = FILES_HEADER.test(line) ? "files" : BLOCK_SCALAR.test(line) ? "scalar" : "plain";
      inItem = false;
      const path = TOP_PATH.exec(line);
      if (path === null && FILE_KEY.test(line)) return null;
      placed.push(path === null ? { at: "top" } : { at: "file", prefix: path[1] ?? "", value: path[2] ?? "" });
      continue;
    }
    if (block === "scalar") {
      placed.push({ at: "nested" });
      continue;
    }
    if (block !== "files" || !line.startsWith(" ")) return null;
    const item = FILES_ITEM.exec(line);
    if (item !== null) {
      inItem = true;
      placed.push({ at: "file", prefix: item[1] ?? "", value: item[2] ?? "" });
      continue;
    }
    if (!inItem || !ITEM_FIELD.test(line) || FILE_KEY.test(line)) return null;
    placed.push({ at: "field" });
  }
  return placed;
}
