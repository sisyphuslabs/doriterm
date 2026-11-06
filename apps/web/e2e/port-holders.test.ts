import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { describePortFailure, listPortHolders } from "./port-holders.ts";

test("a port holder is named by its pid and its command", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    const holders = listPortHolders([address.port]);
    expect(holders.length).toBeGreaterThan(0);
    const mine = holders.find((holder) => holder.port === address.port);
    expect(mine?.pid).toBe(process.pid);
    expect(mine?.command ?? "").toContain("bun");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);

test("a port nobody holds has no holder", () => {
  expect(listPortHolders([1])).toEqual([]);
});

test("the failure names the blocked port and who holds it", () => {
  const described = describePortFailure(
    [{ base: 51_232, blocked: 51_240 }],
    [{ port: 51_240, pid: 4_412, command: "bun" }],
  );
  expect(described).toContain("51232 blocked at 51240");
  expect(described).toContain("pid 4412");
  expect(described).toContain("bun");
});

test("a real listener inside a tried block is named, not the block's first port", async () => {
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
  expect(describePortFailure([], [])).toContain("no listener could be named on the blocked ports");
});

test("a listener that could not be named still reports the bases tried", () => {
  expect(describePortFailure([{ base: 40_001, blocked: 40_020 }], [])).toContain("40001 blocked at 40020");
});
