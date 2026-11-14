import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { loadHostIdentity } from "../state/host-keys.ts";
import { HostUplink } from "./host-uplink.ts";

const stateDir = mkdtempSync(join(tmpdir(), "dh-uplink-log-"));
const identity = loadHostIdentity(stateDir);

let answered = Promise.withResolvers<ServerWebSocket<unknown>>();
/** A relay that challenges each uplink and hands the test its socket once the host has answered. */
const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("upgrade", { status: 426 })),
  websocket: {
    open: (ws) => {
      ws.send(new Uint8Array(32));
    },
    message: (ws, message) => {
      if (typeof message !== "string") answered.resolve(ws);
    },
  },
});

afterAll(async () => {
  await relay.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
});

test.each([
  ["idle", "4408: idle"],
  ["", "4408"],
  ["too\tfar\u00e9", "4408: too?far?"],
])("a closed uplink is logged with the relay's reason beside the code: %p reads (%s)", async (reason, shown) => {
  answered = Promise.withResolvers();
  const closed = Promise.withResolvers<string>();
  const uplink = new HostUplink({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    identity,
    log: (line) => {
      if (line.startsWith("relay: uplink closed")) closed.resolve(line);
    },
  });
  await uplink.start({ onSession: () => {}, onConnected: () => {} });
  try {
    (await answered.promise).close(4408, reason);
    expect(await closed.promise).toMatch(new RegExp(`^relay: uplink closed \\(${shown.replaceAll("?", "\\?")}\\); `));
  } finally {
    await uplink.stop();
  }
});

test("a stable uplink's quick redial is logged as the whole line, its wait under a second as now or in milliseconds", async () => {
  answered = Promise.withResolvers();
  const closed = Promise.withResolvers<string>();
  const uplink = new HostUplink({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    identity,
    log: (line) => {
      if (line.startsWith("relay: uplink closed")) closed.resolve(line);
    },
  });
  await uplink.start({ onSession: () => {}, onConnected: () => {} });
  try {
    const ws = await answered.promise;
    setSystemTime(new Date(Date.now() + 30_000));
    ws.terminate();
    expect(await closed.promise).toMatch(/^relay: uplink closed \(1006\); reconnecting (now|in [1-9][0-9]{0,2} ms)$/);
  } finally {
    setSystemTime();
    await uplink.stop();
  }
});
