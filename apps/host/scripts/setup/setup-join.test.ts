import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPaths } from "./render.ts";
import { joinMesh, type Ran, type RunOptions, type SetupContext } from "./setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LINK = "doriface://pair#h=abc&k=key&s=sig&p=secret&r=wss%3A%2F%2Frelay&m=1";

test("setup join hands the host the link's file, never the link itself on a command line (#821)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dt-setup-join-"));
  roots.push(root);
  const from = join(root, "join-link");
  writeFileSync(from, `${LINK}\n`, { mode: 0o600 });
  const commands: (readonly string[])[] = [];
  const context: SetupContext = {
    os: "linux",
    home: root,
    env: {},
    report: () => {},
    options: {},
    run: (command: readonly string[], _options?: RunOptions): Promise<Ran> => {
      commands.push(command);
      return Promise.resolve({ code: 0, stdout: "joined mesh m1\n", stderr: "" });
    },
  };
  const paths = setupPaths("linux", root, {}, { bun: "/bin/bun", hc: "/bin/hc", shell: "/bin/sh" }, { src: root });
  await joinMesh(context, paths, from);
  expect(commands).toHaveLength(1);
  const [command] = commands;
  expect(command?.some((arg) => arg.includes("secret"))).toBe(false);
  expect(command?.slice(command.indexOf("join"), command.indexOf("join") + 3)).toEqual(["join", "--from-file", from]);
  // The link is single use: once the join answered, its file is gone.
  expect(existsSync(from)).toBe(false);
});
