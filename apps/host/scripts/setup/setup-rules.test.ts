import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderService, renderUnit, type SetupOs, type SetupPaths, setupPaths } from "./render.ts";
import { ensureService, type Ran, resolvePaths, type SetupContext, updateCheckout } from "./setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "dt-setup-rules-"));
  roots.push(root);
  return root;
}

type Answer = (command: readonly string[]) => Partial<Ran> | undefined;

/** A Linux context whose runner records every command and answers from `answer` (exit 0 and no output otherwise). */
function linuxContext(root: string, answer: Answer = () => undefined, options: SetupContext["options"] = {}) {
  const commands: string[] = [];
  const context: SetupContext = {
    os: "linux",
    home: root,
    env: {},
    report: () => {},
    options,
    run: (command) => {
      commands.push(command.join(" "));
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...answer(command) });
    },
  };
  return { context, commands };
}

const tools = (root: string) => ({ bun: join(root, "bun"), hc: join(root, "hc"), shell: "/bin/bash" });

const systemctl = (commands: readonly string[]) =>
  commands.filter((command) => command.startsWith("systemctl --user ") && !command.includes("show-environment"));

const install = (root: string, paths: SetupPaths, checkoutChanged: boolean, active: boolean) => {
  const { context, commands } = linuxContext(root, (command) =>
    command.includes("is-active")
      ? { code: active ? 0 : 3 }
      : command[0] === "loginctl"
        ? { stdout: "yes\n" }
        : undefined,
  );
  return ensureService(context, paths, checkoutChanged).then((result) => ({ result, run: systemctl(commands) }));
};

const checkout = (root: string, head: string, target: string, dirty = "", modules = true) => {
  const src = join(root, "src");
  mkdirSync(join(src, ".git"), { recursive: true });
  if (modules) mkdirSync(join(src, "node_modules"));
  const { context, commands } = linuxContext(
    root,
    (command) => {
      const args = command.join(" ");
      if (args.endsWith("rev-parse FETCH_HEAD")) return { stdout: `${target}\n` };
      if (args.endsWith("rev-parse HEAD")) return { stdout: `${head}\n` };
      if (args.includes("status --porcelain")) return { stdout: dirty };
      return undefined;
    },
    { src },
  );
  return {
    context,
    commands,
    moves: () => commands.filter((c) => c.includes("checkout --quiet") || c.endsWith("install --frozen-lockfile")),
  };
};

/** Installs a unit as an earlier run left it: its own bun, shell, state dir, listener, session and log. */
const installed = (root: string, os: SetupOs = "linux"): SetupPaths => {
  const bun = join(root, "old-bun", "bun");
  mkdirSync(dirname(bun), { recursive: true });
  writeFileSync(bun, "");
  const paths = setupPaths(
    os,
    root,
    {},
    { bun, hc: join(root, "hc"), shell: "/bin/zsh" },
    { stateDir: join(root, "state"), listen: "127.0.0.1:0", session: "work", logFile: join(root, "host.log") },
  );
  mkdirSync(dirname(paths.serviceFile), { recursive: true });
  writeFileSync(paths.serviceFile, renderService(paths));
  return paths;
};

describe("ensureService's restart rules (#821)", () => {
  test("a first install writes the unit, reloads systemd and starts the service", async () => {
    const root = home();
    const paths = setupPaths("linux", root, {}, tools(root));
    const { result, run } = await install(root, paths, false, false);
    expect(readFileSync(paths.serviceFile, "utf8")).toBe(renderUnit(paths));
    expect(result.restarted).toBe(true);
    expect(run).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --quiet doriface-host.service",
      "systemctl --user is-active --quiet doriface-host.service",
      "systemctl --user restart doriface-host.service",
    ]);
  });

  test("a re-run that changes nothing on a running service reloads and restarts nothing", async () => {
    const root = home();
    const paths = setupPaths("linux", root, {}, tools(root));
    await install(root, paths, false, false);
    const { result, run } = await install(root, paths, false, true);
    expect(result.restarted).toBe(false);
    expect(run).toEqual([
      "systemctl --user enable --quiet doriface-host.service",
      "systemctl --user is-active --quiet doriface-host.service",
    ]);
  });

  test("a moved checkout, or a service that is down, restarts it without a reload", async () => {
    const root = home();
    const paths = setupPaths("linux", root, {}, tools(root));
    await install(root, paths, false, false);
    for (const [checkoutChanged, active] of [
      [true, true],
      [false, false],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each case reads the unit the one before it left
      const { result, run } = await install(root, paths, checkoutChanged, active);
      expect(result.restarted).toBe(true);
      expect(run).not.toContain("systemctl --user daemon-reload");
      expect(run.at(-1)).toBe("systemctl --user restart doriface-host.service");
    }
  });

  test("a unit that changed is rewritten, reloaded and restarted", async () => {
    const root = home();
    const paths = setupPaths("linux", root, {}, tools(root));
    await install(root, paths, false, false);
    const moved = { ...paths, listen: "127.0.0.1:0" };
    const { result, run } = await install(root, moved, false, true);
    expect(readFileSync(paths.serviceFile, "utf8")).toBe(renderUnit(moved));
    expect(result.restarted).toBe(true);
    expect(run[0]).toBe("systemctl --user daemon-reload");
    expect(run.at(-1)).toBe("systemctl --user restart doriface-host.service");
  });
});

describe("updateCheckout's rules (#821)", () => {
  test("a checkout already at the branch, with its modules, is left alone", async () => {
    const { context, moves } = checkout(home(), "a".repeat(40), "a".repeat(40));
    expect(await updateCheckout(context, "dev")).toEqual({ sha: "a".repeat(40), changed: false });
    expect(moves()).toEqual([]);
  });

  test("a checkout behind the branch moves to it and installs", async () => {
    const { context, moves } = checkout(home(), "a".repeat(40), "b".repeat(40));
    expect(await updateCheckout(context, "dev")).toEqual({ sha: "b".repeat(40), changed: true });
    expect(moves()).toHaveLength(2);
    expect(moves()[0]).toEndWith(`checkout --quiet --detach ${"b".repeat(40)}`);
  });

  test("a checkout with local edits is refused, never moved", async () => {
    const { context, moves } = checkout(home(), "a".repeat(40), "b".repeat(40), " M apps/host/src/cli.ts\n");
    await expect(updateCheckout(context, "dev")).rejects.toThrow();
    expect(moves()).toEqual([]);
  });

  test("a checkout at the branch with no modules installs them", async () => {
    const { context, moves } = checkout(home(), "a".repeat(40), "a".repeat(40), "", false);
    expect((await updateCheckout(context, "dev")).changed).toBe(true);
    expect(moves()).toHaveLength(1);
  });
});

describe("resolvePaths on a machine with the service installed (#821)", () => {
  test("a re-run with no flags adopts what the installed service runs with, on Linux and macOS", () => {
    for (const os of ["linux", "mac"] as const) {
      const root = home();
      const before = installed(root, os);
      const { context } = linuxContext(root, undefined, { src: before.src });
      const after = resolvePaths({ ...context, os }, join(root, "hc"));
      expect(renderService(after)).toBe(renderService(before));
    }
  });

  test("a flag given on the re-run wins over the installed unit's", () => {
    const root = home();
    const before = installed(root);
    const { context } = linuxContext(root, undefined, { src: before.src, listen: "127.0.0.1:7999", session: "play" });
    const after = resolvePaths(context, join(root, "hc"));
    expect([after.listen, after.session, after.stateDir, after.bun]).toEqual([
      "127.0.0.1:7999",
      "play",
      before.stateDir,
      before.bun,
    ]);
  });

  test("an installed bun that is gone is replaced by the one running now", () => {
    const root = home();
    const before = installed(root);
    rmSync(before.bun);
    const { context } = linuxContext(root, undefined, { src: before.src });
    expect(resolvePaths(context, join(root, "hc")).bun).toBe(process.execPath);
  });
});
