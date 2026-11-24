import { AGENT_MARKS } from "@doriface/ui";
import { describe, expect, test } from "bun:test";
import { AGENT_KINDS, agentKind } from "./agent-kind.ts";
import type { Session } from "./attention.ts";

const terminal = (extra: Partial<Session> = {}): Session => ({
  address: "t1",
  argv: ["zsh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
  ...extra,
});

const reporting = (app: string, extra: Partial<Session> = {}): Session =>
  terminal({ reported: true, status: { state: "working", app }, ...extra });

const running = (...argv: string[]): Session =>
  terminal({ foreground: { argv, cwd: "/work", name: argv[0] ?? "", pid: 7 } });

describe("agentKind", () => {
  test("the agent's own report wins over the program it runs, any case", () => {
    expect(agentKind(reporting("Claude", { argv: ["codex"] }))).toBe("claude");
    expect(agentKind(reporting("codex", { foreground: { argv: ["claude"], cwd: "/", name: "claude", pid: 1 } }))).toBe(
      "codex",
    );
  });

  test("a report that names no known agent falls back to the program", () => {
    expect(agentKind(reporting("my-wrapper", { argv: ["/usr/local/bin/gemini"] }))).toBe("gemini");
    expect(agentKind(reporting("my-wrapper"))).toBeNull();
  });

  test("each alias is its agent, reported or run", () => {
    const aliases = [
      ["claude-code", "claude"],
      ["cursor-agent", "cursor"],
      ["agent", "cursor"],
      ["github-copilot", "copilot"],
      ["grok-build", "grok"],
      ["kimi-code", "kimi"],
      ["kimicodecli", "kimi"],
      ["oh-my-pi", "omp"],
      ["agy", "antigravity"],
      ["qodercli", "qoder"],
      ["kiro-cli", "kiro"],
    ] as const;
    for (const [alias, kind] of aliases) {
      expect(agentKind(reporting(alias))).toBe(kind);
      expect(agentKind(running(`/opt/bin/${alias}`))).toBe(kind);
    }
  });

  test("every kind names itself", () => {
    for (const kind of AGENT_KINDS) expect(agentKind(running(kind))).toBe(kind);
  });

  test("the program in front comes before the one the terminal started; its name stands in for a missing argv", () => {
    expect(
      agentKind(terminal({ argv: ["codex"], foreground: { argv: ["claude"], cwd: "/", name: "x", pid: 1 } })),
    ).toBe("claude");
    expect(agentKind(terminal({ argv: ["zsh"], foreground: { argv: [], cwd: "/", name: "opencode", pid: 1 } }))).toBe(
      "opencode",
    );
    expect(agentKind(terminal({ argv: ["/home/me/.local/bin/amp"] }))).toBe("amp");
  });

  test("a path, a login shell's dash and .exe are not part of the name", () => {
    expect(agentKind(running("C:\\Tools\\Codex.EXE"))).toBe("codex");
    expect(agentKind(running("-claude"))).toBe("claude");
  });

  test("an interpreter is read past: its script names the agent, by file or by its package folder", () => {
    expect(agentKind(running("node", "/usr/local/bin/codex.js"))).toBe("codex");
    expect(agentKind(running("/usr/bin/node", "--no-warnings", "/opt/gemini"))).toBe("gemini");
    expect(agentKind(running("bun", "run", "/x/node_modules/@scope/claude-code/cli.js", "--resume"))).toBe("claude");
    expect(agentKind(running("python3", "/home/me/tool.py"))).toBeNull();
    expect(agentKind(running("node"))).toBeNull();
  });

  test("a folder outside a package tree names nothing: a script kept in ~/codex is not Codex", () => {
    expect(agentKind(running("node", "/home/me/codex/server.js"))).toBeNull();
  });

  test("a shell or env wrapper is read past: the command it runs names the agent", () => {
    expect(agentKind(running("sh", "-c", "exec claude --continue"))).toBe("claude");
    expect(agentKind(running("/bin/bash", "-lc", "FOO=1 /opt/bin/codex resume"))).toBe("codex");
    expect(agentKind(running("env", "TERM=xterm", "gemini"))).toBe("gemini");
    expect(agentKind(running("sh", "-c", "while true; do sleep 1; done"))).toBeNull();
  });

  test("a shell at its prompt, another program and nothing known are no agent", () => {
    expect(agentKind(terminal())).toBeNull();
    expect(agentKind(running("vim", "claude.md"))).toBeNull();
    expect(agentKind(terminal({ argv: [] }))).toBeNull();
  });

  test("every key of AGENT_MARKS is a known agent kind or one of the three generic kinds", () => {
    const allowed = new Set<string>([...AGENT_KINDS, "agent", "shell", "program"]);
    for (const kind of Object.keys(AGENT_MARKS)) expect(allowed.has(kind)).toBe(true);
  });
});
