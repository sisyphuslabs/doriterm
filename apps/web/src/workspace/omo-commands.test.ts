import { describe, expect, test } from "bun:test";
import type { Terminal } from "@doriface/protocol";
import {
  commandCache,
  type ExecOn,
  listCommands,
  matchCommands,
  namingCommand,
  omoProgram,
  parseCommands,
} from "./omo-commands.ts";

const running = (argv: readonly string[], name = argv[0] ?? ""): Terminal =>
  ({ address: "a", argv: ["zsh"], labels: {}, foreground: { argv, name, cwd: "/w", pid: 1 } }) as unknown as Terminal;

const reply = (commands: readonly object[]): string =>
  [
    JSON.stringify({ type: "model_changed" }),
    JSON.stringify({ id: "x", type: "response", command: "get_commands", success: true, data: { commands } }),
  ].join("\n");

describe("omoProgram", () => {
  test("names OmO started from the PATH or a path, and nothing else", () => {
    expect(omoProgram(running(["omo"]))).toBe("omo");
    expect(omoProgram(running(["/opt/bin/omo", "--resume"]))).toBe("/opt/bin/omo");
    expect(omoProgram(running(["/bin/sh", "/opt/fake/omo"], "omo"))).toBe("/opt/fake/omo");
    expect(omoProgram(running(["vim"]))).toBeNull();
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

test("listCommands runs OmO in RPC mode on the terminal's machine with the request on stdin", async () => {
  const calls: unknown[] = [];
  const exec: ExecOn = {
    call: ((method: string, params: unknown) => {
      calls.push([method, params]);
      return Promise.resolve({
        stdout: btoa(reply([{ name: "goal", syntax: "slash" }])),
        stderr: "",
        ms: 1,
        timed_out: false,
        truncated: false,
      });
    }) as ExecOn["call"],
  };
  const commands = await listCommands(exec, { machine: "box", program: "omo", cwd: "/w" });
  expect(commands).toEqual([{ name: "goal", description: "" }]);
  const [method, params] = calls[0] as [string, { argv: string[]; on: string; cwd: string; input: string }];
  expect(method).toBe("machine.exec");
  expect(params.argv).toEqual(["omo", "--mode", "rpc", "--no-session"]);
  expect(params.on).toBe("box");
  expect(params.cwd).toBe("/w");
  expect(JSON.parse(atob(params.input))).toMatchObject({ type: "get_commands" });
});

test("the cache asks once per machine and asks again after a failure", async () => {
  let asked = 0;
  let fail = true;
  const cached = commandCache(() => {
    asked += 1;
    return fail ? Promise.reject(new Error("down")) : Promise.resolve([{ name: "goal", description: "" }]);
  });
  const exec: ExecOn = { call: (() => Promise.reject(new Error("unused"))) as ExecOn["call"] };
  const where = { machine: "box", program: "omo", cwd: "/w" };
  await expect(cached(exec, where)).rejects.toThrow("down");
  fail = false;
  await cached(exec, where);
  await cached(exec, { ...where, cwd: "/elsewhere" });
  expect(asked).toBe(2);
  await cached(exec, { ...where, machine: "other" });
  expect(asked).toBe(3);
});

test("a typed word lists the commands starting with it, then those containing it", () => {
  const commands = ["goal", "todo", "go", "logout"].map((name) => ({ name, description: "" }));
  expect(matchCommands(commands, "/go").map((each) => each.name)).toEqual(["goal", "go", "logout"]);
  expect(matchCommands(commands, "/o").map((each) => each.name)).toEqual(["goal", "todo", "go", "logout"]);
  expect(matchCommands(commands, "/").length).toBe(4);
  expect(namingCommand("/go")).toBe(true);
  expect(namingCommand("/goal now")).toBe(false);
  expect(namingCommand("go")).toBe(false);
});
