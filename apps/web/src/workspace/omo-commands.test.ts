import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, watch as fsWatch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@doriface/protocol";
import {
  commandCache,
  type ExecOn,
  listCommands,
  matchCommands,
  namingCommand,
  omoProgram,
  freshSlash,
  parseCommands,
  PROBE,
} from "./omo-commands.ts";

const running = (argv: readonly string[], name = argv[0] ?? ""): Terminal =>
  ({ address: "a", argv: ["zsh"], labels: {}, foreground: { argv, name, cwd: "/w", pid: 1 } }) as unknown as Terminal;

const reply = (commands: readonly object[]): string =>
  [
    JSON.stringify({ type: "model_changed" }),
    JSON.stringify({ id: "x", type: "response", command: "get_commands", success: true, data: { commands } }),
  ].join("\n");

describe("omoProgram", () => {
  test("names OmO started from the PATH, a path, or as an interpreter's script", () => {
    expect(omoProgram(running(["omo"]))).toBe("omo");
    expect(omoProgram(running(["/opt/bin/omo", "--resume"]))).toBe("/opt/bin/omo");
    expect(omoProgram(running(["/bin/sh", "/opt/fake/omo"], "omo"))).toBe("/opt/fake/omo");
    expect(omoProgram(running(["node", "/opt/omo/omo", "--resume"], "node"))).toBe("/opt/omo/omo");
    // A bare name run by an interpreter is the file in the terminal's directory, never one found on the PATH.
    expect(omoProgram(running(["bash", "omo"], "bash"))).toBe("./omo");
    expect(omoProgram(running(["node", "bin/omo"], "node"))).toBe("bin/omo");
  });

  test("a file named omo that another program opens is not OmO", () => {
    expect(omoProgram(running(["vim", "omo"]))).toBeNull();
    expect(omoProgram(running(["less", "./downloads/omo"]))).toBeNull();
    expect(omoProgram(running(["tail", "-f", "logs/omo"]))).toBeNull();
    expect(omoProgram(running(["node", "script.js", "omo"]))).toBeNull();
    expect(omoProgram(running(["zsh"]))).toBeNull();
  });
});

describe("parseCommands", () => {
  test("keeps the slash commands of the get_commands reply and leaves skills out", () => {
    const out = reply([
      { name: "todo", description: "Show the todo list", syntax: "slash" },
      { name: "skill:x", description: "a skill", syntax: "dollar" },
      { name: "help" },
    ]);
    expect(parseCommands(out)).toEqual([
      { name: "todo", description: "Show the todo list" },
      { name: "help", description: "" },
    ]);
  });

  test("output with no reply is a failure, not an empty list", () => {
    expect(() => parseCommands('{"type":"model_changed"}\n')).toThrow();
  });
});

const execReturning = (stdout: string, calls: unknown[] = []): ExecOn => ({
  call: ((method: string, params: unknown) => {
    calls.push([method, params]);
    return Promise.resolve({ stdout: btoa(stdout), stderr: "", ms: 1, timed_out: false, truncated: false });
  }) as ExecOn["call"],
});

test("listCommands runs the probe on the terminal's machine and directory with OmO and the request in its env", async () => {
  const calls: unknown[] = [];
  const commands = await listCommands(execReturning(reply([{ name: "goal", syntax: "slash" }]), calls), {
    machine: "box",
    program: "/opt/omo",
    cwd: "/w",
  });
  expect(commands).toEqual([{ name: "goal", description: "" }]);
  const [method, params] = calls[0] as [string, { line: string; on: string; cwd: string; env: Record<string, string> }];
  expect(method).toBe("machine.exec");
  expect(params.line).toBe(PROBE);
  expect(params.on).toBe("box");
  expect(params.cwd).toBe("/w");
  expect(params.env["DORITERM_OMO"]).toBe("/opt/omo");
  expect(JSON.parse(params.env["DORITERM_OMO_REQUEST"] ?? "")).toMatchObject({ type: "get_commands" });
});

describe("the probe", () => {
  // A stand-in for OmO's RPC mode: answers the request, then runs until its stdin ends, as OmO does; a probe that never
  // closed it would hang here, and one that read no reply would print nothing.
  const STAND_IN = [
    "#!/bin/sh",
    "IFS= read -r request || exit 1",
    `printf '%s\\n' '{"type":"model_changed"}' '${reply([{ name: "goal" }]).split("\n")[1]}'`,
    "while IFS= read -r rest; do :; done",
  ].join("\n");

  test("sends the request, reads the reply, then ends OmO by closing its stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-probe-"));
    try {
      writeFileSync(join(dir, "omo"), STAND_IN);
      chmodSync(join(dir, "omo"), 0o755);
      const run = Bun.spawn(["sh", "-c", PROBE], {
        cwd: dir,
        env: {
          PATH: process.env["PATH"] ?? "",
          TMPDIR: dir,
          DORITERM_OMO: join(dir, "omo"),
          DORITERM_OMO_REQUEST: '{"type":"get_commands"}',
        },
        stdout: "pipe",
      });
      const out = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      expect(parseCommands(out)).toEqual([{ name: "goal", description: "" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a probe ended by a timeout's TERM leaves no directory behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-probe-term-"));
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  try {
    // A stand-in that takes the request, says so, and never answers, so only the TERM ends the probe. The TERM is sent
    // once the request has arrived: before that the probe may still be opening its FIFOs, where no shell runs a trap.
    writeFileSync(
      join(dir, "omo"),
      `#!/bin/sh\nIFS= read -r request\n: > "${join(dir, "asked")}"\nwhile IFS= read -r line; do :; done\n`,
    );
    chmodSync(join(dir, "omo"), 0o755);
    const asked = new Promise<void>((done) => {
      const watch = fsWatch(dir, (_event, name) => {
        if (String(name) === "asked") {
          watch.close();
          done();
        }
      });
    });
    const run = Bun.spawn(["sh", "-c", PROBE], {
      env: {
        PATH: process.env["PATH"] ?? "",
        TMPDIR: scratch,
        DORITERM_OMO: join(dir, "omo"),
        DORITERM_OMO_REQUEST: "{}",
      },
      stdout: "ignore",
    });
    await asked;
    run.kill("SIGTERM");
    await run.exited;
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the cache", () => {
  const exec = execReturning("");
  const where = { machine: "box", program: "omo", cwd: "/w" };

  test("asks once per machine, program and directory, and again after a failure", async () => {
    let asked = 0;
    let fail = true;
    const cached = commandCache({
      list: () => {
        asked += 1;
        return fail ? Promise.reject(new Error("down")) : Promise.resolve([{ name: "goal", description: "" }]);
      },
      now: () => 0,
    });
    await expect(cached(exec, where)).rejects.toThrow("down");
    fail = false;
    await cached(exec, where);
    await cached(exec, where);
    expect(asked).toBe(2);
    await cached(exec, { ...where, cwd: "/elsewhere" });
    expect(asked).toBe(3);
    await cached(exec, { ...where, machine: "other" });
    expect(asked).toBe(4);
  });

  test("a listing older than its lifetime is read again", async () => {
    let asked = 0;
    let clock = 0;
    const cached = commandCache({
      list: () => {
        asked += 1;
        return Promise.resolve([]);
      },
      now: () => clock,
      ttlMs: 1000,
    });
    await cached(exec, where);
    clock = 999;
    await cached(exec, where);
    expect(asked).toBe(1);
    clock = 1000;
    await cached(exec, where);
    expect(asked).toBe(2);
  });
});

const named = (...names: string[]) => names.map((name) => ({ name, description: "" }));
const names = (list: readonly { name: string }[]) => list.map((each) => each.name);

describe("matchCommands", () => {
  test("the exact name first, then those starting with the word, then those containing it", () => {
    expect(names(matchCommands(named("goal", "todo", "go", "logout"), "/go"))).toEqual(["go", "goal", "logout"]);
    expect(names(matchCommands(named("sessions", "session"), "/session"))).toEqual(["session", "sessions"]);
    expect(names(matchCommands(named("goal", "todo", "go", "logout"), "/o"))).toEqual(["goal", "todo", "go", "logout"]);
    expect(matchCommands(named("goal", "todo"), "/").length).toBe(2);
  });
});

test("a line is a command being named while it is a / and one word", () => {
  expect(namingCommand("/go")).toBe(true);
  expect(namingCommand("/goal now")).toBe(false);
  expect(namingCommand("go")).toBe(false);
});

test("a new / starts naming a command; letters after it do not", () => {
  expect(freshSlash("", "/")).toBe(true);
  expect(freshSlash("/", "/g")).toBe(false);
  expect(freshSlash("/goal x", "/goal")).toBe(true);
  expect(freshSlash("", "go")).toBe(false);
});
