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
/** A reply line holds 256 KiB, and base64 grows the bytes by a third. */
const BYTES_LIMIT = 128 * 1024;

// `st PATH` prints "type<TAB>size<TAB>mtime" on GNU (stat -c) and BSD or macOS (stat -f) alike, without following links.
const STAT = `st() { if stat -c %s / >/dev/null 2>&1; then stat -c '%F\t%s\t%Y' -- "$1"; else stat -f '%HT\t%z\t%m' -- "$1"; fi; }`;
const SCRIPTS = {
  stat: `${STAT}; [ -e "$1" ] || [ -L "$1" ] || exit 3; st "$1"`,
  list: `${STAT}; [ -d "$1" ] || exit 4; n=0; for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; n=$((n+1)); [ $n -gt ${LIST_LIMIT} ] && { echo more; break; }; printf '%s\t%s\n' "$(st "$f")" "\${f##*/}"; done`,
  glob: `[ -d "$1" ] || exit 4; find "$1" \\( -name .git -o -name node_modules \\) -prune -o -type f -name "$2" -print | head -n ${LIST_LIMIT + 1}`,
  grep: `[ -e "$1" ] || exit 3; grep -rnI $3 --exclude-dir=.git --exclude-dir=node_modules -E -e "$2" -- "$1" | head -n ${MATCH_LIMIT + 1}`,
  bytes: `${STAT}; [ -f "$1" ] || exit 4; st "$1"; tail -c +$(($2 + 1)) -- "$1" | head -c $3`,
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
async function runScript(exec: Exec, args: JsonObject, script: string, values: readonly string[]): Promise<Uint8Array> {
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
  if (result.code !== 0 && stderr !== "") throw new FileToolRefused(stderr);
  return Buffer.from(result.stdout, "base64");
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
const lines = (bytes: Uint8Array): string[] => Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean);

/** Files and folders beyond hc's file_read, file_write and file_edit, run by machine.exec under the same gate. */
export const FILE_TOOLS: readonly FileTool[] = [
  {
    name: "file_list",
    description: `List a folder: each entry's name, type (file, dir, link), size and mtime, dotfiles included, up to ${LIST_LIMIT}.`,
    inputSchema: object({ path: { type: "string" } }, ["path"]),
    run: async (args, exec) => {
      const path = text(args, "path");
      const rows = lines(await runScript(exec, args, SCRIPTS.list, [path]));
      const more = rows.at(-1) === "more";
      const entries = (more ? rows.slice(0, -1) : rows).map((row) => {
        const cut = row.lastIndexOf("\t");
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
      return { path, ...statLine(lines(await runScript(exec, args, SCRIPTS.stat, [path]))[0] ?? "") };
    },
  },
  {
    name: "file_glob",
    description: `Find files under a folder whose name matches a pattern such as *.ts, skipping .git and node_modules; up to ${LIST_LIMIT}.`,
    inputSchema: object({ path: { type: "string" }, pattern: { type: "string" } }, ["path", "pattern"]),
    run: async (args, exec) => {
      const found = lines(await runScript(exec, args, SCRIPTS.glob, [text(args, "path"), text(args, "pattern")]));
      return { paths: found.slice(0, LIST_LIMIT), more: found.length > LIST_LIMIT };
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
      const found = lines(await runScript(exec, args, SCRIPTS.grep, values)).map((row) => {
        const [path = "", line = "0", ...rest] = row.split(":");
        return { path, line: Number(line), text: rest.join(":") };
      });
      return { matches: found.slice(0, MATCH_LIMIT), more: found.length > MATCH_LIMIT };
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
      const out = await runScript(exec, args, SCRIPTS.bytes, [path, String(offset), String(asked ?? BYTES_LIMIT + 1)]);
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
