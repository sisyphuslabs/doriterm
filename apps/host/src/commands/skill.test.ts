import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenControl } from "../control.ts";
import type { ControlRequest } from "../control-requests.ts";
import { skillCommand } from "./skill.ts";

const bundle = { version: "0.1.22", files: [{ path: "SKILL.md", text: "---\nname: doriterm\n---\n" }] };
const now = () => new Date("2026-11-19T00:00:00.000Z");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dh-skill-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(args: readonly string[], notified: string[] = []) {
  let text = "";
  const code = await skillCommand(args, (chunk) => (text += chunk), {
    bundle,
    home,
    now,
    notify: async (stateDir) => notified.push(stateDir),
  });
  return { code, text };
}

const statusJson = async () => JSON.parse((await run(["status", "--json"])).text);

describe("doriface-host skill", () => {
  test("status reads missing, install makes it installed at the host's version, and a foreign copy is left alone", async () => {
    expect(await statusJson()).toEqual({ bundled: "0.1.22", dirs: [{ dir: "~/.agents/skills", state: "missing" }] });
    mkdirSync(join(home, ".claude", "skills", "doriterm"), { recursive: true });
    const notified: string[] = [];
    const install = await run(["install", "--state-dir", join(home, "state")], notified);
    expect(install).toEqual({
      code: 0,
      text:
        "~/.agents/skills/doriterm: installed v0.1.22\n" +
        "~/.claude/skills/doriterm: left alone: a doriterm skill this host did not write is there\n",
    });
    expect(notified).toEqual([join(home, "state")]);
    expect(await statusJson()).toEqual({
      bundled: "0.1.22",
      dirs: [
        { dir: "~/.agents/skills", state: "installed", version: "0.1.22" },
        { dir: "~/.claude/skills", state: "foreign" },
      ],
    });
    expect((await run(["uninstall"])).text).toBe(
      "~/.agents/skills/doriterm: removed\n~/.claude/skills/doriterm: left alone: this host did not write it\n",
    );
  });

  test("a directory that cannot be written is named, the others are written, the host is told, and it exits 1", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "skills"), "not a directory");
    const notified: string[] = [];
    const install = await run(["install"], notified);
    expect(install.code).toBe(1);
    expect(install.text).toStartWith(
      "~/.agents/skills/doriterm: installed v0.1.22\n~/.claude/skills/doriterm: failed: ",
    );
    expect(notified).toHaveLength(1);
  });

  test("an unknown action is refused", async () => {
    await expect(run(["reinstall"])).rejects.toThrow("unknown skill reinstall");
  });
});

describe("skill-changed on the control socket", () => {
  test("a running host is told, and answers that it wrote its facts again", async () => {
    const stateDir = join(home, "state");
    mkdirSync(stateDir);
    const seen: ControlRequest[] = [];
    const listener = listenControl(stateDir, async (request) => {
      seen.push(request);
      return { refreshed: true };
    });
    try {
      let text = "";
      await skillCommand(["install", "--state-dir", stateDir], (chunk) => (text += chunk), { bundle, home, now });
      expect(seen).toEqual([{ op: "skill-changed" }]);
      expect(text).toContain("installed v0.1.22");
    } finally {
      listener.stop();
    }
  });

  test("with no host running, install still installs", async () => {
    let text = "";
    const code = await skillCommand(["install", "--state-dir", join(home, "none")], (chunk) => (text += chunk), {
      bundle,
      home,
      now,
    });
    expect([code, text]).toEqual([0, "~/.agents/skills/doriterm: installed v0.1.22\n"]);
  });
});
