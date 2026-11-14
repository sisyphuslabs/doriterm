import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { relaySpawnEnv, withoutBunNodeShim } from "./node-path.ts";

const shim = join("/tmp", "bun-node-1000-38afee6c8");

test("wrangler's PATH leaves out the directory bunx --bun puts first, whose node is bun (#2327)", () => {
  const env = { PATH: [shim, "/home/u/.local/bin", "/usr/bin"].join(delimiter), HOME: "/home/u" };
  expect(withoutBunNodeShim(env)).toEqual({
    PATH: ["/home/u/.local/bin", "/usr/bin"].join(delimiter),
    HOME: "/home/u",
  });
});

test("a PATH without the shim, or no PATH at all, is passed on as it is", () => {
  const plain = { PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter) };
  expect(withoutBunNodeShim(plain)).toEqual(plain);
  expect(withoutBunNodeShim({ HOME: "/home/u" })).toEqual({ HOME: "/home/u" });
});

test("a shim directory named just bun-node, as a Bun build without a commit hash makes, goes too (#2346)", () => {
  const bare = join("/tmp", "bun-node");
  expect(withoutBunNodeShim({ PATH: [bare, "/usr/bin"].join(delimiter) })).toEqual({ PATH: "/usr/bin" });
});

test("only a directory named like the shim goes: one that merely contains the words stays", () => {
  const kept = join("/opt", "my-bun-node-tools");
  expect(withoutBunNodeShim({ PATH: [shim, kept].join(delimiter) })).toEqual({ PATH: kept });
});

test("relay:dev and relay:test start their child without the shim, with the relay checkout named (#2346)", () => {
  const env = { PATH: [shim, "/usr/bin"].join(delimiter), HOME: "/home/u" };
  expect(relaySpawnEnv("/r/.relay", env)).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/u",
    DORIFACE_RELAY_DIR: "/r/.relay",
  });
});

test("relay:dev starts wrangler through relaySpawnEnv: the real command line drops the shim (#2346 review)", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-dev-env-"));
  try {
    const relay = join(root, "relay");
    const bin = join(relay, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const seen = join(root, "seen.txt");
    // A stand-in wrangler that records the PATH and relay dir it was started with.
    writeFileSync(join(bin, "wrangler"), `#!/bin/sh\nprintf '%s\\n%s\\n' "$PATH" "$DORIFACE_RELAY_DIR" > "${seen}"\n`);
    chmodSync(join(bin, "wrangler"), 0o755);
    const fakeShim = join(root, "bun-node-1000-feedface");
    mkdirSync(fakeShim);
    const script = join(import.meta.dir, "..", "private-relay.ts");
    const proc = Bun.spawn([process.execPath, script, "dev"], {
      env: { ...process.env, PATH: [fakeShim, process.env["PATH"] ?? ""].join(delimiter), DORIFACE_RELAY_DIR: relay },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);
    const [path, dir] = (await Bun.file(seen).text()).split("\n");
    expect(dir).toBe(relay);
    expect(path?.split(delimiter)).not.toContain(fakeShim);
    expect(path?.split(delimiter).length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
