import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  installSkill,
  MARKER_FILE,
  NoBundledSkill,
  SKILL_NAME,
  type SkillBundle,
  skillStatus,
  type SkillTarget,
  uninstallSkill,
} from "./agent-skill.ts";
import { readSkillSource } from "./bundle-macro.ts";
import { BUNDLED_SKILL } from "../commands/skill.ts";

const FILES = [
  { path: "SKILL.md", text: "---\nname: doriterm\n---\nuse hc\n" },
  { path: "references/hc.md", text: "hc run\n" },
];
const bundle = (version: string, files = FILES): SkillBundle => ({ version, files });
const clock = () => new Date("2026-11-19T00:00:00.000Z");

let root: string;
let agents: SkillTarget;
let claude: SkillTarget;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dh-skill-"));
  agents = { path: join(root, ".agents", "skills"), shown: "~/.agents/skills" };
  claude = { path: join(root, ".claude", "skills"), shown: "~/.claude/skills" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (target: SkillTarget, path: string): string => readFileSync(join(target.path, SKILL_NAME, path), "utf8");

describe("skill status", () => {
  test("a clean machine reads missing in every directory", async () => {
    expect(await skillStatus(bundle("0.1.22"), [agents, claude])).toEqual({
      bundled: "0.1.22",
      dirs: [
        { dir: "~/.agents/skills", state: "missing" },
        { dir: "~/.claude/skills", state: "missing" },
      ],
    });
  });

  test("after install it reads installed with the host's version, and the files and marker are there", async () => {
    expect(await installSkill(bundle("0.1.22"), [agents], clock)).toEqual([
      { dir: "~/.agents/skills", action: "written" },
    ]);
    expect(await skillStatus(bundle("0.1.22"), [agents])).toEqual({
      bundled: "0.1.22",
      dirs: [{ dir: "~/.agents/skills", state: "installed", version: "0.1.22" }],
    });
    expect(read(agents, "references/hc.md")).toBe("hc run\n");
    expect(JSON.parse(read(agents, MARKER_FILE))).toMatchObject({
      writer: "doriface-host",
      version: "0.1.22",
      installedAt: "2026-11-19T00:00:00.000Z",
    });
    // Nothing of the staging is left beside the skill.
    expect(readdirSync(agents.path)).toEqual([SKILL_NAME]);
  });

  test("a copy an older host wrote reads outdated, and a newer host's copy stays installed", async () => {
    await installSkill(bundle("0.1.21"), [agents], clock);
    await installSkill(bundle("0.1.23"), [claude], clock);
    expect((await skillStatus(bundle("0.1.22"), [agents, claude])).dirs).toEqual([
      { dir: "~/.agents/skills", state: "outdated", version: "0.1.21" },
      { dir: "~/.claude/skills", state: "installed", version: "0.1.23" },
    ]);
  });

  test("the same version with other content (another build) reads outdated", async () => {
    await installSkill(bundle("0.1.22", [{ path: "SKILL.md", text: "old\n" }]), [agents], clock);
    expect((await skillStatus(bundle("0.1.22"), [agents])).dirs[0]?.state).toBe("outdated");
  });

  test("a hand-made doriterm directory reads foreign, with or without a marker of another shape", async () => {
    mkdirSync(join(agents.path, SKILL_NAME), { recursive: true });
    writeFileSync(join(agents.path, SKILL_NAME, "SKILL.md"), "mine\n");
    mkdirSync(join(claude.path, SKILL_NAME), { recursive: true });
    writeFileSync(join(claude.path, SKILL_NAME, MARKER_FILE), '{"writer":"someone"}');
    expect((await skillStatus(bundle("0.1.22"), [agents, claude])).dirs.map((dir) => dir.state)).toEqual([
      "foreign",
      "foreign",
    ]);
  });

  test("a build without the skill reports bundled null", async () => {
    expect((await skillStatus(bundle("0.1.22", []), [agents])).bundled).toBeNull();
  });
});

describe("skill install", () => {
  test("never overwrites a foreign copy, and installs the other directories", async () => {
    mkdirSync(join(agents.path, SKILL_NAME), { recursive: true });
    writeFileSync(join(agents.path, SKILL_NAME, "SKILL.md"), "mine\n");
    expect(await installSkill(bundle("0.1.22"), [agents, claude], clock)).toEqual([
      { dir: "~/.agents/skills", action: "foreign" },
      { dir: "~/.claude/skills", action: "written" },
    ]);
    expect(read(agents, "SKILL.md")).toBe("mine\n");
    expect(readdirSync(join(agents.path, SKILL_NAME))).toEqual(["SKILL.md"]);
  });

  test("updates an outdated copy in place, dropping files the new bundle no longer has", async () => {
    await installSkill(bundle("0.1.21", [...FILES, { path: "references/gone.md", text: "x" }]), [agents], clock);
    expect(await installSkill(bundle("0.1.22"), [agents], clock)).toEqual([
      { dir: "~/.agents/skills", action: "updated" },
    ]);
    expect(readdirSync(join(agents.path, SKILL_NAME, "references"))).toEqual(["hc.md"]);
    expect(readdirSync(agents.path)).toEqual([SKILL_NAME]);
  });

  test("a current copy is left as it is", async () => {
    await installSkill(bundle("0.1.22"), [agents], clock);
    expect(await installSkill(bundle("0.1.22"), [agents], clock)).toEqual([
      { dir: "~/.agents/skills", action: "unchanged" },
    ]);
  });

  test("outdatedOnly updates what an older host wrote and writes nothing where the skill is missing", async () => {
    await installSkill(bundle("0.1.21"), [agents], clock);
    expect(await installSkill(bundle("0.1.22"), [agents, claude], clock, true)).toEqual([
      { dir: "~/.agents/skills", action: "updated" },
      { dir: "~/.claude/skills", action: "unchanged" },
    ]);
    expect((await skillStatus(bundle("0.1.22"), [claude])).dirs[0]?.state).toBe("missing");
  });

  test("a build without the skill refuses to install and writes nothing", async () => {
    await expect(installSkill(bundle("0.1.22", []), [agents], clock)).rejects.toBeInstanceOf(NoBundledSkill);
    expect((await skillStatus(bundle("0.1.22"), [agents])).dirs[0]?.state).toBe("missing");
  });

  test("a write that fails leaves the old copy in place and no staging behind", async () => {
    await installSkill(bundle("0.1.21"), [agents], clock);
    // A path that escapes into a file where a directory must go makes the staging write fail.
    const broken = bundle("0.1.22", [...FILES, { path: "SKILL.md/inner.md", text: "x" }]);
    const [result] = await installSkill(broken, [agents], clock);
    expect(result?.action).toBe("failed");
    expect((await skillStatus(bundle("0.1.21"), [agents])).dirs[0]?.state).toBe("installed");
    expect(readdirSync(agents.path)).toEqual([SKILL_NAME]);
  });

  test("a directory that cannot be written is reported failed, and the next one is still written", async () => {
    mkdirSync(join(root, ".agents"));
    writeFileSync(agents.path, "a file where the skills directory should be");
    const results = await installSkill(bundle("0.1.22"), [agents, claude], clock);
    expect(results.map((result) => result.action)).toEqual(["failed", "written"]);
    expect(results[0]?.error).toBeString();
    expect((await skillStatus(bundle("0.1.22"), [claude])).dirs[0]?.state).toBe("installed");
  });

  test("a doriterm symlink is foreign, even one to a copy a host wrote, and is left as it is", async () => {
    await installSkill(bundle("0.1.21"), [claude], clock);
    mkdirSync(agents.path, { recursive: true });
    symlinkSync(join(claude.path, SKILL_NAME), join(agents.path, SKILL_NAME));
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    const dangling = { path: root, shown: "~" };
    renameSync(join(root, "dangling"), join(root, SKILL_NAME));
    expect((await skillStatus(bundle("0.1.22"), [agents, dangling])).dirs.map((dir) => dir.state)).toEqual([
      "foreign",
      "foreign",
    ]);
    expect((await installSkill(bundle("0.1.22"), [agents], clock))[0]?.action).toBe("foreign");
    expect(lstatSync(join(agents.path, SKILL_NAME)).isSymbolicLink()).toBe(true);
  });

  test("the skill is readable by everyone, as a skill directory is, and a crashed install's staging is swept", async () => {
    mkdirSync(join(agents.path, `.${SKILL_NAME}.new-crashed`), { recursive: true });
    await installSkill(bundle("0.1.22"), [agents], clock);
    expect(statSync(join(agents.path, SKILL_NAME)).mode & 0o777).toBe(0o755);
    expect(readdirSync(agents.path)).toEqual([SKILL_NAME]);
  });

  test("a live writer's lock refuses a second install at once; a lock its writer left behind is taken over", async () => {
    mkdirSync(agents.path, { recursive: true });
    const lockFile = join(agents.path, `.${SKILL_NAME}.lock`);
    writeFileSync(lockFile, String(process.pid));
    const [held] = await installSkill(bundle("0.1.22"), [agents], clock);
    expect([held?.action, held?.error]).toEqual([
      "failed",
      `another install of the doriterm skill is running in ${agents.path}`,
    ]);
    // No process has pid 2^22 + 1 on Linux or macOS: the writer that held it is gone.
    writeFileSync(lockFile, String(4_194_305));
    expect((await installSkill(bundle("0.1.22"), [agents], clock))[0]?.action).toBe("written");
    expect(readdirSync(agents.path)).toEqual([SKILL_NAME]);
  });
});

describe("skill uninstall", () => {
  test("removes what a host wrote and leaves a foreign copy", async () => {
    await installSkill(bundle("0.1.22"), [agents], clock);
    mkdirSync(join(claude.path, SKILL_NAME), { recursive: true });
    expect(await uninstallSkill(bundle("0.1.22"), [agents, claude])).toEqual([
      { dir: "~/.agents/skills", action: "removed" },
      { dir: "~/.claude/skills", action: "foreign" },
    ]);
    expect((await skillStatus(bundle("0.1.22"), [agents, claude])).dirs.map((dir) => dir.state)).toEqual([
      "missing",
      "foreign",
    ]);
  });
});

describe("the bundle", () => {
  test("reads every file under the source, nested ones with / paths, and refuses a missing source", () => {
    mkdirSync(join(root, "src", "references"), { recursive: true });
    writeFileSync(join(root, "src", "SKILL.md"), "a");
    writeFileSync(join(root, "src", "references", "b.md"), "b");
    expect(readSkillSource(join(root, "src"))).toEqual([
      { path: "SKILL.md", text: "a" },
      { path: "references/b.md", text: "b" },
    ]);
    expect(() => readSkillSource(join(root, "none"))).toThrow("skills/doriterm");
  });

  test("the host carries every file under the repository's skills/doriterm, SKILL.md among them", () => {
    const source = join(import.meta.dir, "..", "..", "..", "..", "skills", "doriterm");
    const onDisk = readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .toSorted();
    expect(BUNDLED_SKILL.files.map((file) => file.path).toSorted()).toEqual(onDisk);
    expect(onDisk).toContain("SKILL.md");
  });
});
