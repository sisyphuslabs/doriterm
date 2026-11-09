import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHcSession } from "./hc-session.ts";

const real = { ...fs };
/** While set, a watchFile watcher is never polled, as Bun's stat scheduler leaves one it strands under load (#1547). */
let stranded = false;
/** While set, lstat of this path throws this error, as if the probe could not see the socket. */
let lstatFails: { readonly path: string; readonly error: Error } | undefined;
await mock.module("node:fs", () => ({
  ...real,
  watchFile: (...args: Parameters<typeof fs.watchFile>) => (stranded ? undefined : real.watchFile(...args)),
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (lstatFails !== undefined && args[0] === lstatFails.path) throw lstatFails.error;
    return real.lstatSync(...args);
  },
}));
const { ownMeshSession } = await import("./mesh-session.ts");

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: probe`), { code });
}

function socketOf(session: ReturnType<typeof createHcSession>): string {
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("no socket");
  return socket;
}

test("a mesh session is ready once its core serves, even when no stat watcher reports the socket", async () => {
  const scratch = createHcSession("mesh-ready");
  // ownMeshSession starts any watcher before its first await, so only its own is stranded.
  stranded = true;
  const ready = ownMeshSession(scratch);
  stranded = false;
  // Rejects with "mesh core did not create its socket" when readiness waits on the watcher.
  const session = await ready;
  await session.dispose();
}, 60_000);

test("the deadline says the socket was never created when the probe never saw it", async () => {
  const scratch = createHcSession("mesh-unseen");
  lstatFails = { path: socketOf(scratch), error: errno("ENOENT") };
  try {
    const error = await ownMeshSession(scratch).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toStartWith("mesh core did not create its socket within ");
    expect(message).toContain("socket first seen: never");
  } finally {
    lstatFails = undefined;
  }
}, 60_000);

test("the deadline says the core accepted no connection when its socket was seen", async () => {
  const scratch = createHcSession("mesh-refused");
  const socket = socketOf(scratch);
  const connect = Bun.connect;
  const refused = spyOn(Bun, "connect").mockImplementation((async (options: Parameters<typeof Bun.connect>[0]) => {
    if ("unix" in options && options.unix === socket) throw errno("ECONNREFUSED");
    return connect(options);
  }) as typeof Bun.connect);
  try {
    const error = await ownMeshSession(scratch).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toStartWith("mesh core created its socket but accepted no connection within ");
    expect(message).toMatch(/socket first seen: \+\d+ ms/);
    expect(message).toContain("first connection: never");
  } finally {
    refused.mockRestore();
  }
}, 60_000);

test("an unexpected probe error fails readiness with the startup timeline and the error as its cause", async () => {
  const scratch = createHcSession("mesh-probe-error");
  const cause = errno("EAGAIN");
  lstatFails = { path: socketOf(scratch), error: cause };
  try {
    const error = await ownMeshSession(scratch).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toStartWith("mesh core readiness probe failed: ");
    expect(message).toContain("socket first seen: never");
    expect(message).toContain("core stderr tail: ");
    expect((error as Error).cause).toBe(cause);
  } finally {
    lstatFails = undefined;
  }
}, 60_000);
