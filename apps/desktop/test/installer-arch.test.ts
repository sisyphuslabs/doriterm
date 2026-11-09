import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #1298: an arm64-only setup run on x64 Windows selected no payload yet "installed", leaving only an uninstaller and a
 * dead shortcut. The guard is the customInit macro in build/installer.nsh. No NSIS runs on Linux, so this evaluates
 * that shipped macro for every payload set electron-builder can embed (it defines APP_64 / APP_ARM64) on every native
 * Windows architecture. Anything outside the small NSIS subset modelled here throws, so the test cannot drift from
 * the file unnoticed. Running the real setup.exe still needs Windows.
 */
const source = readFileSync(join(import.meta.dir, "..", "build", "installer.nsh"), "utf8");

type Payload = "APP_64" | "APP_ARM64";
type Machine = "x64" | "arm64" | "x86";
interface Outcome {
  readonly exitCode?: number;
  readonly message?: string;
  readonly removed: readonly string[];
}

function customInit(): string[] {
  const body = /^!macro customInit\n([\s\S]*?)^!macroend/m.exec(source);
  if (!body) throw new Error("installer.nsh has no customInit macro");
  return (body[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/\s#.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Compile-time pass: keep the lines whose !ifdef / !else branch matches the embedded payloads. */
function preprocess(lines: readonly string[], payloads: readonly Payload[]): string[] {
  const kept: string[] = [];
  const stack: { parent: boolean; on: boolean }[] = [];
  const active = () => stack.every((frame) => frame.on);
  for (const line of lines) {
    const ifdef = /^!ifdef (\w+)$/.exec(line);
    if (ifdef) {
      stack.push({ parent: active(), on: payloads.includes(ifdef[1] as Payload) });
    } else if (line === "!else") {
      const frame = stack.at(-1);
      if (!frame) throw new Error("!else without !ifdef");
      frame.on = !frame.on;
    } else if (line === "!endif") {
      if (!stack.pop()) throw new Error("!endif without !ifdef");
    } else if (active()) {
      kept.push(line);
    }
  }
  if (stack.length !== 0) throw new Error("unterminated !ifdef");
  return kept;
}

/** Run-time pass on a machine of the given native architecture. */
function run(payloads: readonly Payload[], machine: Machine, silent: boolean): Outcome {
  const lines = preprocess(customInit(), payloads);
  const flags: Record<string, boolean> = {
    IsNativeARM64: machine === "arm64",
    IsNativeAMD64: machine === "x64",
    Silent: silent,
  };
  const flag = (expr: string) => {
    const name = /^\$\{(\w+)\}$/.exec(expr)?.[1];
    if (!name || !(name in flags)) throw new Error(`unmodelled condition ${expr}`);
    return flags[name] as boolean;
  };
  const registers: Record<string, string> = { $INSTDIR: "<install dir>" };
  const expand = (text: string) => text.replace(/\$\w+/g, (name) => registers[name] ?? name);
  const removed: string[] = [];
  let message: string | undefined;
  let exitCode: number | undefined;
  // Each frame: is the enclosing code running, and has a branch of this ${If} already been taken.
  const ifs: { parent: boolean; on: boolean; taken: boolean }[] = [];
  const running = () => ifs.every((frame) => frame.on);
  for (let pc = 0; pc < lines.length; pc++) {
    const line = lines[pc] as string;
    const [word = "", ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    if (word === "${If}" || word === "${IfNot}") {
      const on = running() && flag(arg) === (word === "${If}");
      ifs.push({ parent: running(), on, taken: on });
      continue;
    }
    const frame = ifs.at(-1);
    if (word === "${OrIf}" || word === "${ElseIf}" || word === "${EndIf}") {
      if (!frame) throw new Error(`${word} outside \${If}`);
      if (word === "${EndIf}") ifs.pop();
      else if (word === "${OrIf}") frame.on = frame.parent && (frame.on || flag(arg));
      else frame.on = frame.parent && !frame.taken && flag(arg);
      frame.taken ||= frame.on;
      continue;
    }
    if (!running() || /^\w+:$/.test(line)) continue;
    if (word === "Push" || word === "Pop") continue;
    if (word === "StrCpy") {
      const set = /^(\$\w+) "(.*)"$/.exec(arg);
      if (!set) throw new Error(`unmodelled StrCpy ${arg}`);
      registers[set[1] as string] = expand(set[2] as string);
    } else if (word === "Goto") {
      pc = lines.indexOf(`${arg}:`);
      if (pc < 0) throw new Error(`no label ${arg}`);
      ifs.length = 0; // every label in the macro sits outside any ${If}
    } else if (word === "MessageBox") {
      message = expand(/"(.*)"$/.exec(arg)?.[1] ?? "");
    } else if (word === "SetOutPath") {
      // moves the working directory off $INSTDIR so RMDir can remove it
    } else if (word === "RMDir") {
      removed.push(expand(arg));
    } else if (word === "SetErrorLevel") {
      exitCode = Number(arg);
    } else if (word === "Quit") {
      return { exitCode: exitCode ?? 0, ...(message === undefined ? {} : { message }), removed };
    } else {
      throw new Error(`unmodelled NSIS instruction: ${line}`);
    }
  }
  return { removed, ...(message === undefined ? {} : { message }) };
}

const ARM64_ONLY: Payload[] = ["APP_ARM64"];
const X64_ONLY: Payload[] = ["APP_64"];
const BOTH: Payload[] = ["APP_64", "APP_ARM64"];

describe("the Windows setup's architecture guard (#1298)", () => {
  test.each([
    ["arm64 setup", "arm64", ARM64_ONLY],
    ["x64 setup", "x64", X64_ONLY],
    ["x64 setup, through emulation,", "arm64", X64_ONLY],
    ["combined setup", "x64", BOTH],
    ["combined setup", "arm64", BOTH],
  ] as const)("%s installs on %s Windows", (_name, machine, payloads) => {
    for (const silent of [true, false]) expect(run(payloads, machine, silent)).toEqual({ removed: [] });
  });

  test.each([
    ["arm64 setup", "x64", ARM64_ONLY],
    ["arm64 setup", "x86", ARM64_ONLY],
    ["combined setup", "x86", BOTH],
  ] as const)("%s refuses %s Windows with 1633 under /S, without a dialog", (_name, machine, payloads) => {
    expect(run(payloads, machine, true)).toEqual({ exitCode: 1633, removed: ["<install dir>"] });
  });

  // On real x86 Windows electron-builder's own 64-bit check (common.nsh) shows its dialog and quits before this guard runs.
  test("the guard macro alone refuses an x64 setup on x86 Windows with 1633 under /S", () => {
    expect(run(X64_ONLY, "x86", true)).toEqual({ exitCode: 1633, removed: ["<install dir>"] });
  });

  test("an interactive refusal names the setup's and the machine's architecture", () => {
    const outcome = run(ARM64_ONLY, "x64", false);
    expect(outcome.exitCode).toBe(1633);
    expect(outcome.message).toContain("contains arm64, but this machine runs x64 Windows");
  });

  test("a refusal removes only an empty install folder, never an existing install's files", () => {
    // RMDir without /r fails on a non-empty folder, so an earlier install survives a refused setup.
    expect(run(ARM64_ONLY, "x64", true).removed).toEqual(["<install dir>"]);
    expect(customInit().filter((line) => line.startsWith("RMDir"))).toEqual(["RMDir $INSTDIR"]);
  });
});
