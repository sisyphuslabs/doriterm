import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePortFailure, listPortHolders } from "./port-holders.ts";

// The tests that name a real listener need `ss` or `lsof`; a machine with neither skips them and says why.
const noTool = listPortHolders([1]).unnamed;
if (noTool !== undefined) console.warn(`port-holders: skipping the real-listener tests: ${noTool}`);
const withTool = test.skipIf(noTool !== undefined);

withTool(
  "a port holder is named by its pid and its command",
  async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      const { holders } = listPortHolders([address.port]);
      expect(holders.length).toBeGreaterThan(0);
      const mine = holders.find((holder) => holder.port === address.port);
      expect(mine?.pid).toBe(process.pid);
      expect(mine?.command ?? "").toContain("bun");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15_000,
);

withTool("a port nobody holds has no holder", () => {
  expect(listPortHolders([1])).toEqual({ holders: [] });
});

test("the failure names the blocked port and who holds it", () => {
  const described = describePortFailure([{ base: 51_232, blocked: 51_240 }], {
    holders: [{ port: 51_240, pid: 4_412, command: "bun" }],
  });
  expect(described).toContain("51232 blocked at 51240");
  expect(described).toContain("pid 4412");
  expect(described).toContain("bun");
});

withTool("a real listener inside a tried block is named, not the block's first port", async () => {
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", () => resolve()));
  const address = held.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    const base = Math.max(1, address.port - 5);
    const described = describePortFailure([{ base, blocked: address.port }], listPortHolders([base, address.port]));
    expect(described).toContain("blocked at");
    expect(described).toContain(`port ${String(address.port)} held by pid ${String(process.pid)}`);
  } finally {
    await new Promise<void>((resolve) => held.close(() => resolve()));
  }
});

test("the failure says so when no listener could be named", () => {
  expect(describePortFailure([], { holders: [] })).toContain("no listener could be named on the blocked ports");
});

test("a listener that could not be named still reports the bases tried", () => {
  expect(describePortFailure([{ base: 40_001, blocked: 40_020 }], { holders: [] })).toContain("40001 blocked at 40020");
});

test("a port whose listener no tool could name is reported as unknown, not as free", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const empty = mkdtempSync(join(tmpdir(), "no-tools-"));
  try {
    const found = listPortHolders([address.port], { PATH: empty });
    expect(found.holders).toEqual([]);
    expect(found.unnamed).toContain("not installed");
    expect(describePortFailure([{ base: address.port, blocked: address.port }], found)).toContain(found.unnamed ?? "?");
  } finally {
    rmSync(empty, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
