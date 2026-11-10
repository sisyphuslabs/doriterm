import { HC_VERSION_FLOOR } from "@doriface/protocol";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHc, type SetupContext } from "./setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A HOME whose ~/.local/bin holds a foreign `hc` and a herdr-core, each answering --version with `versions[name]`. */
function machine(versions: Readonly<Record<string, string>>): SetupContext {
  const home = mkdtempSync(join(tmpdir(), "dt-setup-hc-"));
  roots.push(home);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of Object.keys(versions)) writeFileSync(join(bin, name), "");
  return {
    os: "linux",
    home,
    env: {},
    report: () => {},
    options: {},
    run: (command) =>
      Promise.resolve({ code: 0, stdout: `${versions[command[0]?.split("/").at(-1) ?? ""] ?? ""}\n`, stderr: "" }),
  };
}

test("the commands after install skip an hc below the floor and use the herdr-core install chose (#821)", async () => {
  const context = machine({ hc: "hc 0.0.3", "herdr-core": `herdr-core ${HC_VERSION_FLOOR}` });
  expect(await findHc(context)).toBe(join(context.home, ".local", "bin", "herdr-core"));
});

test("with no herdr-core at the floor, they say to run install instead of using an older one (#821)", async () => {
  await expect(findHc(machine({ hc: "hc 0.0.3" }))).rejects.toThrow(
    `no herdr-core at or above ${HC_VERSION_FLOOR} is installed; run install first`,
  );
});
