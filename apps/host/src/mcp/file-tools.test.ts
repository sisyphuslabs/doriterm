import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExecResult, MachineExecParams } from "@doriface/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_TOOLS, FileToolRefused, type FileTool } from "./file-tools.ts";

let dir: string;
let calls: MachineExecParams[];

/** machine.exec as hc runs it here: argv without a shell, from cwd, output base64. */
async function exec(params: MachineExecParams): Promise<ExecResult> {
  calls.push(params);
  const child = Bun.spawn([...(params.argv ?? [])], { cwd: params.cwd ?? dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
    child.exited,
  ]);
  return {
    code,
    ms: 1,
    stdout: Buffer.from(stdout).toString("base64"),
    stderr: Buffer.from(stderr).toString("base64"),
    timed_out: false,
    truncated: false,
  };
}

const tool = (name: string): FileTool => {
  const found = FILE_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-file-tools-"));
  calls = [];
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "hello\nworld\n");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  writeFileSync(join(dir, "src", "main.ts"), "const answer = 42;\nexport default answer;\n");
  writeFileSync(join(dir, "src", "deep", "util.ts"), "export const ANSWER = 42;\n");
  writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "const answer = 42;\n");
  writeFileSync(join(dir, "blob.bin"), new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("file_list names each entry with its type and size, dotfiles included, folders marked", async () => {
  const listed = await tool("file_list").run({ path: dir }, exec);
  expect(listed).toMatchObject({ path: dir, more: false });
  const entries = Reflect.get(Object(listed), "entries");
  expect(entries).toContainEqual(expect.objectContaining({ name: "README.md", type: "file", size: 12 }));
  expect(entries).toContainEqual(expect.objectContaining({ name: ".env", type: "file" }));
  expect(entries).toContainEqual(expect.objectContaining({ name: "src", type: "dir" }));
  expect(entries.every((entry: { mtime: unknown }) => typeof entry.mtime === "number")).toBe(true);
});

test("file_list passes on and cwd to machine.exec, so a relative path resolves as hc's file tools resolve it", async () => {
  await tool("file_list")
    .run({ path: "src", cwd: dir, on: "studio" }, exec)
    .catch(() => undefined);
  expect(calls[0]).toMatchObject({ cwd: dir, on: "studio" });
  calls = [];
  const listed = await tool("file_list").run({ path: "src", cwd: dir }, exec);
  expect(Reflect.get(Object(listed), "entries")).toContainEqual(expect.objectContaining({ name: "deep", type: "dir" }));
});

test("file_list on a file or a missing path is refused with what is wrong", async () => {
  await expect(tool("file_list").run({ path: join(dir, "README.md") }, exec)).rejects.toThrow("not a folder");
  await expect(tool("file_list").run({ path: join(dir, "nope") }, exec)).rejects.toThrow("not a folder");
});

test("file_stat answers a file's and a folder's type, size and mtime, and refuses a missing path", async () => {
  expect(await tool("file_stat").run({ path: join(dir, "README.md") }, exec)).toMatchObject({ type: "file", size: 12 });
  expect(await tool("file_stat").run({ path: join(dir, "src") }, exec)).toMatchObject({ type: "dir" });
  await expect(tool("file_stat").run({ path: join(dir, "nope") }, exec)).rejects.toThrow("no such file or folder");
});

test("file_glob finds files by name under a folder and skips .git and node_modules", async () => {
  const found = await tool("file_glob").run({ path: dir, pattern: "*.ts" }, exec);
  const paths: string[] = Reflect.get(Object(found), "paths");
  expect(paths.toSorted()).toEqual([join(dir, "src", "deep", "util.ts"), join(dir, "src", "main.ts")]);
});

test("file_grep answers matching lines with file and line number, and an empty list when nothing matches", async () => {
  const hits = await tool("file_grep").run({ path: dir, pattern: "answer = 4[0-9]" }, exec);
  expect(Reflect.get(Object(hits), "matches")).toEqual([
    { path: join(dir, "src", "main.ts"), line: 1, text: "const answer = 42;" },
  ]);
  const insensitive = await tool("file_grep").run({ path: dir, pattern: "ANSWER = 42", ignoreCase: true }, exec);
  expect(Reflect.get(Object(insensitive), "matches")).toHaveLength(2);
  expect(await tool("file_grep").run({ path: dir, pattern: "no such words" }, exec)).toEqual({
    matches: [],
    more: false,
  });
});

test("file_read_bytes answers a binary file as base64, byte for byte, and reads a part with offset and length", async () => {
  const whole = await tool("file_read_bytes").run({ path: join(dir, "blob.bin") }, exec);
  expect(whole).toEqual({ data: Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]).toString("base64"), size: 9 });
  const part = await tool("file_read_bytes").run({ path: join(dir, "blob.bin"), offset: 3, length: 2 }, exec);
  expect(part).toEqual({ data: Buffer.from([250, 251]).toString("base64"), size: 9 });
});

test("file_read_bytes refuses more than one reply holds, and says to read it in parts", async () => {
  writeFileSync(join(dir, "big.bin"), new Uint8Array(200 * 1024));
  await expect(tool("file_read_bytes").run({ path: join(dir, "big.bin") }, exec)).rejects.toThrow("in parts");
  const part = await tool("file_read_bytes").run({ path: join(dir, "big.bin"), length: 1024 }, exec);
  expect(Reflect.get(Object(part), "size")).toBe(200 * 1024);
});

test("arguments that do not fit are refused before anything runs", async () => {
  await expect(tool("file_list").run({}, exec)).rejects.toBeInstanceOf(FileToolRefused);
  await expect(tool("file_grep").run({ path: dir }, exec)).rejects.toThrow("pattern");
  await expect(tool("file_read_bytes").run({ path: dir, length: -1 }, exec)).rejects.toThrow("length");
  expect(calls).toHaveLength(0);
});
