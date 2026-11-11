import { expect, test } from "bun:test";
import { delimiter, join } from "node:path";
import { relaySpawnEnv } from "../relay/private-relay.ts";

const shim = join("/tmp", "bun-node-1000-38afee6c8");

test("relay:dev and relay:test start their child without the directory bunx --bun puts first on PATH (#2346)", () => {
  const env = { PATH: [shim, "/usr/bin"].join(delimiter), HOME: "/home/u" };
  expect(relaySpawnEnv("/r/.relay", env)).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/u",
    DORIFACE_RELAY_DIR: "/r/.relay",
  });
});
