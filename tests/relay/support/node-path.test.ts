import { expect, test } from "bun:test";
import { delimiter, join } from "node:path";
import { withoutBunNodeShim } from "./node-path.ts";

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
