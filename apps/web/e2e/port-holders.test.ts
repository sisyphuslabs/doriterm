import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePortFailure, listPortHolders } from "./port-holders.ts";

// The tests that name a real listener need `ss` or `lsof`; a machine with neither skips them and says why.
const noTool = listPortHolders([1]).unnamed;
if (noTool !== undefined) console.warn(`port-holders: skipping the real-listener tests: ${noTool}`);
const withTool = test.skipIf(noTool !== undefined);

// The scratch PATH dirs below hold `#!/bin/sh` scripts, which only a POSIX machine can run.
if (process.platform === "win32") console.warn("port-holders: skipping the scratch-tool tests: no /bin/sh");
const withScratchTools = test.skipIf(process.platform === "win32");

/** Writes an executable `name` into `dir`, so a scratch PATH can offer exactly that tool. */
const writeTool = (dir: string, name: string, script: string): void => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}`, { mode: 0o755 });
};

// Finding the real `lsof` lets a test put only that tool on PATH; the tests that need it skip without it.
const lsofPath = Bun.which("lsof");
if (lsofPath === null) console.warn("port-holders: skipping the lsof-only tests: lsof not installed");
const withLsof = test.skipIf(lsofPath === null);
// Only Linux asks `ss` first, so only there can a failing `ss` fall through to `lsof`.
const withSsThenLsof = test.skipIf(process.platform !== "linux" || lsofPath === null);

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

// #1133: on Linux without iproute2 (#1027) `ss` is missing while `lsof` is present; the fallback must name the
// listener.
withLsof(
  "a listener is named when only lsof is on PATH",
  async () => {
    if (lsofPath === null) throw new Error("lsof is missing");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const onlyLsof = mkdtempSync(join(tmpdir(), "lsof-only-"));
    try {
      symlinkSync(lsofPath, join(onlyLsof, "lsof"));
      const found = listPortHolders([address.port], { PATH: onlyLsof });
      expect(found.unnamed).toBeUndefined();
      expect(found.holders.find((holder) => holder.port === address.port)?.pid).toBe(process.pid);
    } finally {
      rmSync(onlyLsof, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15_000,
);

// #1134: a tool can start and still fail (ss without netlink permission); lsof must be asked instead.
withSsThenLsof(
  "on Linux, an ss that starts but exits non-zero falls through to lsof",
  async () => {
    if (lsofPath === null) throw new Error("lsof is missing");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const scratch = mkdtempSync(join(tmpdir(), "failing-ss-"));
    try {
      writeTool(scratch, "ss", "echo 'Cannot open netlink socket: Operation not permitted' >&2\nexit 2\n");
      symlinkSync(lsofPath, join(scratch, "lsof"));
      const found = listPortHolders([address.port], { PATH: scratch });
      expect(found.unnamed).toBeUndefined();
      expect(found.holders.find((holder) => holder.port === address.port)?.pid).toBe(process.pid);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15_000,
);

withScratchTools("a tool that exits non-zero is a failed lookup, not a free port", () => {
  const scratch = mkdtempSync(join(tmpdir(), "failing-tools-"));
  try {
    writeTool(scratch, "ss", "echo 'Cannot open netlink socket: Operation not permitted' >&2\nexit 2\n");
    writeTool(scratch, "lsof", "echo 'lsof: no permission to inspect processes' >&2\nexit 2\n");
    const found = listPortHolders([1], { PATH: scratch });
    expect(found.holders).toEqual([]);
    const unnamed = found.unnamed ?? "";
    expect(unnamed).toContain("lsof");
    expect(unnamed).toContain("failed with exit 2");
    if (process.platform === "linux") expect(unnamed).toContain("ss");
    expect(describePortFailure([{ base: 1, blocked: 1 }], found)).toContain("could not be looked up");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

withScratchTools("a tool that exits 1 without output found no listener, not a failure", () => {
  const scratch = mkdtempSync(join(tmpdir(), "lsof-no-match-"));
  try {
    writeTool(scratch, "ss", "exit 2\n");
    writeTool(scratch, "lsof", "exit 1\n");
    expect(listPortHolders([1], { PATH: scratch })).toEqual({ holders: [] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
