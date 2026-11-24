import type { JsonObject, MachineExecParams } from "@doriface/protocol";

/** Runs one program through the session's own core connection, as hc's machine.exec does: here, or on `on`. */
export type Exec = (params: MachineExecParams) => Promise<unknown>;

export interface FileTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly run: (args: JsonObject, exec: Exec) => Promise<unknown>;
}

/** A call whose arguments do not fit, or whose path is not what the tool needs; the caller reads the message. */
export class FileToolRefused extends Error {}

const LIST_LIMIT = 1000;
const MATCH_LIMIT = 200;
/** A reply line holds 256 KiB and carries the value twice (content text and structuredContent); base64 adds a third. */
const BYTES_LIMIT = 64 * 1024;
/** The most text list, glob and grep take from the machine, so two copies of it fit one reply line. */
const OUTPUT_BUDGET = 32 * 1024;

// `st PATH` prints "type<TAB>size<TAB>mtime" on GNU (stat -c) and BSD or macOS (stat -f) alike, without following links.
const STAT = `st() { l=; [ "$1" = -L ] && { l=-L; shift; }; if stat -c %s / >/dev/null 2>&1; then stat $l -c '%F\t%s\t%Y' -- "$1"; else stat $l -f '%HT\t%z\t%m' -- "$1"; fi; }`;
const SCRIPTS = {
  stat: `${STAT}; [ -e "$1" ] || [ -L "$1" ] || exit 3; st "$1"`,
  list: `${STAT}; [ -d "$1" ] || exit 4; n=0; for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; n=$((n+1)); [ $n -gt ${LIST_LIMIT} ] && { printf 'more\\0'; break; }; printf '%s\t%s\\0' "$(st "$f")" "\${f##*/}"; done | head -c ${OUTPUT_BUDGET}`,
  glob: `[ -d "$1" ] || exit 4; find "$1" \\( -name .git -o -name node_modules \\) -prune -o -type f -name "$2" -print | head -n ${LIST_LIMIT + 1} | head -c ${OUTPUT_BUDGET}`,
  grep: `[ -e "$1" ] || exit 3; { grep -rnIH --null $3 --exclude-dir=.git --exclude-dir=node_modules -E -e "$2" -- "$1"; echo "grep-exit $?" >&2; } | head -n ${MATCH_LIMIT + 1} | head -c ${OUTPUT_BUDGET}`,
  bytes: `${STAT}; [ -f "$1" ] || exit 4; st -L "$1"; tail -c +$(($2 + 1)) -- "$1" | head -c $3`,
} as const;

const object = (properties: JsonObject, required: readonly string[]): JsonObject => ({
  type: "object",
  properties: { ...properties, ...WHERE },
  required: [...required],
  additionalProperties: false,
});
const WHERE: JsonObject = {
  on: { type: "string", description: "On another machine (machine_list); default this one." },
  cwd: { type: "string", description: "Where a relative path starts; default as file_read." },
};
const text = (args: JsonObject, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value === "") throw new FileToolRefused(`${key} must be a non-empty string`);
  return value;
};
const count = (args: JsonObject, key: string, fallback: number): number => {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FileToolRefused(`${key} must be a whole number, 0 or more`);
  }
  return value;
};
const where = (args: JsonObject): Pick<MachineExecParams, "on" | "cwd"> => ({
  ...(typeof args["on"] === "string" ? { on: args["on"] } : {}),
  ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
});

const REFUSALS: Readonly<Record<number, string>> = { 3: "no such file or folder", 4: "not a folder" };

/** Runs a script with its arguments as $1.., never through a shell line, and answers its stdout bytes. */
async function runScript(
  exec: Exec,
  args: JsonObject,
  script: string,
  values: readonly string[],
): Promise<{ readonly out: Uint8Array; readonly err: string }> {
  const reply: unknown = await exec({ argv: ["sh", "-c", script, "sh", ...values], ...where(args), timeout: 60 });
  const field = (key: string): unknown => Reflect.get(Object(reply), key);
  const [stdout, stderrText, code] = [field("stdout"), field("stderr"), field("code")];
  if (typeof stdout !== "string" || typeof stderrText !== "string") throw new Error("machine.exec answered no output");
  const result = {
    stdout,
    stderr: stderrText,
    code: typeof code === "number" ? code : null,
    timed_out: field("timed_out") === true,
  };
  const stderr = Buffer.from(result.stderr, "base64").toString("utf8").trim();
  if (result.code !== 0 && result.code !== null && REFUSALS[result.code] !== undefined) {
    throw new FileToolRefused(`${values[0]}: ${REFUSALS[result.code]}`);
  }
  if (result.timed_out) throw new FileToolRefused("it took longer than 60 s");
  if (result.code !== 0)
    throw new FileToolRefused(stderr === "" ? `${values[0]}: exited ${String(result.code)}` : stderr);
  return { out: Buffer.from(result.stdout, "base64"), err: stderr };
}

const TYPES: Readonly<Record<string, string>> = { directory: "dir", "symbolic link": "link" };
function statLine(line: string): { readonly type: string; readonly size: number; readonly mtime: number } {
  const [kind = "", size = "0", mtime = "0"] = line.split("\t");
  const lower = kind.toLowerCase();
  return {
    type: lower.includes("regular") ? "file" : (TYPES[lower] ?? "other"),
    size: Number(size),
    mtime: Number(mtime),
  };
}
/** The output's lines; output cut at the budget loses its last, partial line and reports that more was left. */
function lines(bytes: Uint8Array, separator = "\n"): string[] & { cut?: boolean } {
  const all = Buffer.from(bytes).toString("utf8").split(separator);
  const cut = bytes.length >= OUTPUT_BUDGET;
  const rows: string[] & { cut?: boolean } = (cut ? all.slice(0, -1) : all).filter(Boolean);
  rows.cut = cut;
  return rows;
}

/** Files and folders beyond hc's file_read, file_write and file_edit, run by machine.exec under the same gate. */
export const FILE_TOOLS: readonly FileTool[] = [
  {
    name: "file_list",
    description: `List a folder: each entry's name, type (file, dir, link), size and mtime, dotfiles included, up to ${LIST_LIMIT}.`,
    inputSchema: object({ path: { type: "string" } }, ["path"]),
    run: async (args, exec) => {
      const path = text(args, "path");
      const rows = lines((await runScript(exec, args, SCRIPTS.list, [path])).out, "\0");
      const more = rows.at(-1) === "more" || rows.cut === true;
      const entries = (more ? rows.slice(0, -1) : rows).map((row) => {
        const cut = row.indexOf("\t", row.indexOf("\t", row.indexOf("\t") + 1) + 1);
        const { type, size, mtime } = statLine(row.slice(0, cut));
        return { name: row.slice(cut + 1), type, size, mtime };
      });
      return { path, entries, more };
    },
  },
  {
    name: "file_stat",
    description: "A file's or folder's type (file, dir, link), size in bytes and mtime, without reading it.",
    inputSchema: object({ path: { type: "string" } }, ["path"]),
    run: async (args, exec) => {
      const path = text(args, "path");
      return { path, ...statLine(lines((await runScript(exec, args, SCRIPTS.stat, [path])).out)[0] ?? "") };
    },
  },
  {
    name: "file_glob",
    description: `Find files under a folder whose name matches a pattern such as *.ts, skipping .git and node_modules; up to ${LIST_LIMIT}.`,
    inputSchema: object({ path: { type: "string" }, pattern: { type: "string" } }, ["path", "pattern"]),
    run: async (args, exec) => {
      const found = lines((await runScript(exec, args, SCRIPTS.glob, [text(args, "path"), text(args, "pattern")])).out);
      return { paths: found.slice(0, LIST_LIMIT), more: found.length > LIST_LIMIT || found.cut === true };
    },
  },
  {
    name: "file_grep",
    description: `Search file contents under a path with an extended regular expression; matching lines with file and line number, up to ${MATCH_LIMIT}.`,
    inputSchema: object({ path: { type: "string" }, pattern: { type: "string" }, ignoreCase: { type: "boolean" } }, [
      "path",
      "pattern",
    ]),
    run: async (args, exec) => {
      const values = [text(args, "path"), text(args, "pattern"), args["ignoreCase"] === true ? "-i" : "-s"];
      const { out, err } = await runScript(exec, args, SCRIPTS.grep, values);
      const rows = lines(out);
      // grep exits 2 when it could not read something; what it found is then not the whole answer.
      const incomplete = /grep-exit 2/.test(err);
      // grep --null ends each file name with NUL, so a name with ':' in it stays whole: name NUL line ':' text.
      const found = rows.map((row) => {
        const name = row.indexOf("\0");
        const colon = row.indexOf(":", name + 1);
        return { path: row.slice(0, name), line: Number(row.slice(name + 1, colon)), text: row.slice(colon + 1) };
      });
      return {
        matches: found.slice(0, MATCH_LIMIT),
        more: found.length > MATCH_LIMIT || rows.cut === true,
        ...(incomplete ? { incomplete: true } : {}),
      };
    },
  },
  {
    name: "file_read_bytes",
    description: `Read a file's bytes as base64, for files that are not text. At most ${BYTES_LIMIT / 1024} KiB per call; read a larger file in parts with offset and length.`,
    inputSchema: object({ path: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" } }, [
      "path",
    ]),
    run: async (args, exec) => {
      const path = text(args, "path");
      const offset = count(args, "offset", 0);
      const asked = args["length"] === undefined ? undefined : count(args, "length", 0);
      if (asked !== undefined && asked > BYTES_LIMIT)
        throw new FileToolRefused(`length must be at most ${BYTES_LIMIT}`);
      const { out } = await runScript(exec, args, SCRIPTS.bytes, [
        path,
        String(offset),
        String(asked ?? BYTES_LIMIT + 1),
      ]);
      const cut = out.indexOf(10);
      const { size } = statLine(Buffer.from(out.subarray(0, cut)).toString("utf8"));
      const data = out.subarray(cut + 1);
      if (asked === undefined && data.length > BYTES_LIMIT) {
        throw new FileToolRefused(
          `${path} is ${size} bytes; read it in parts with offset and length (at most ${BYTES_LIMIT})`,
        );
      }
      return { data: Buffer.from(data).toString("base64"), size };
    },
  },
];
