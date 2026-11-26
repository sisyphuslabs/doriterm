import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launch, launchPathIn, resumeExec, shownCommand, writeLaunch } from "./resume-exec.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "resume-exec-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const launches = join(scratch, "launches");
const work = join(scratch, "work");
mkdirSync(work);
const uid = process.getuid?.() ?? 0;

const writeLaunchFile = (dir: string, launch: Launch): string => {
  const path = launchPathIn(dir);
  writeLaunch(path, launch);
  return path;
};

/** Runs the helper on a launch file: its exit code, the refusals it said, and the file's path. */
async function run(launch: Launch, path = writeLaunchFile(launches, launch)) {
  const lines: string[] = [];
  const say = (line: string): void => void lines.push(line);
  const code = await resumeExec(path, { stdio: ["ignore", "inherit", "inherit"], say, waitMs: 2_000 });
  return { code, lines, path };
}

const recorder = (out: string): string[] => ["sh", "-c", 'printf "%s\\n" "$PWD" "$@" > "$0"', out];

describe.skipIf(process.platform === "win32")("resumeExec", () => {
  test("starts the command found on PATH in its cwd, each element one argument, and removes the launch file", async () => {
    const out = join(scratch, "args.txt");
    const result = await run({
      argv: [...recorder(out), "$(touch pwned)", "a; b", "", "-S"],
      cwd: work,
      cwdReported: true,
      uid,
    });
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${work}\n$(touch pwned)\na; b\n\n-S\n`);
    expect(existsSync(join(work, "pwned"))).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  test("the program gets its reported name as argv[0] and the exit code comes back", async () => {
    const out = join(scratch, "name.txt");
    const script = process.platform === "linux" ? 'tr "\\0" " " < /proc/$$/cmdline > "$0"; exit 7' : "exit 7";
    const result = await run({ argv: ["sh", "-c", script, out], cwd: undefined, cwdReported: false, uid });
    expect(result.code).toBe(7);
    if (process.platform === "linux") expect(readFileSync(out, "utf8").split(" ")[0]).toBe("sh");
  });

  test("a reported cwd that is gone is not resumed; one the terminal found is replaced by where it starts", async () => {
    const out = join(scratch, "fallback.txt");
    const gone = await run({ argv: recorder(out), cwd: join(scratch, "nope"), cwdReported: true, uid });
    expect(gone.code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(gone.path)).toBe(false);
    const fallback = await run({ argv: recorder(out), cwd: join(scratch, "nope"), cwdReported: false, uid });
    expect(fallback.code).toBe(0);
    expect(readFileSync(out, "utf8").split("\n")[0]).toBe(process.cwd());
  });

  test("a command not on PATH, another user's launch, or a bad argv is refused", async () => {
    expect((await run({ argv: ["no-such-program-7577"], cwd: undefined, cwdReported: false, uid })).code).not.toBe(0);
    expect((await run({ argv: ["true"], cwd: undefined, cwdReported: false, uid: uid + 1 })).code).not.toBe(0);
    expect((await run({ argv: ["./true"], cwd: undefined, cwdReported: false, uid })).code).not.toBe(0);
    expect((await run({ argv: ["true", "a\nb"], cwd: undefined, cwdReported: false, uid })).code).not.toBe(0);
  });

  test("a launch file others can read, or a link to one, is refused and nothing runs", async () => {
    const out = join(scratch, "open.txt");
    const open = writeLaunchFile(launches, { argv: recorder(out), cwd: undefined, cwdReported: false, uid });
    chmodSync(open, 0o644);
    expect((await run({ argv: [], cwd: undefined, cwdReported: false, uid }, open)).code).not.toBe(0);
    const target = writeLaunchFile(launches, { argv: recorder(out), cwd: undefined, cwdReported: false, uid });
    const link = join(launches, "link.json");
    symlinkSync(target, link);
    expect((await run({ argv: [], cwd: undefined, cwdReported: false, uid }, link)).code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("resumeExec waits for its launch file", () => {
  test("one written after it started runs; one never written is refused once the wait is over", async () => {
    const out = join(scratch, "late.txt");
    const path = launchPathIn(launches);
    const running = resumeExec(path, { stdio: ["ignore", "inherit", "inherit"], say: () => {}, waitMs: 20_000 });
    writeLaunch(path, { argv: recorder(out), cwd: work, cwdReported: true, uid });
    expect(await running).toBe(0);
    expect(readFileSync(out, "utf8").split("\n")[0]).toBe(work);
    const lines: string[] = [];
    const never = await resumeExec(launchPathIn(launches), { say: (line) => lines.push(line), waitMs: 50 });
    expect(never).toBe(1);
    expect(lines.join("\n")).toContain("gone");
  });
});

test("shownCommand escapes what could mislead a reader: controls and direction overrides", () => {
  expect(shownCommand(["nvim", "a b", "x\u202Eexe.txt"])).toBe('nvim "a b" "x\\u202eexe.txt"');
});
