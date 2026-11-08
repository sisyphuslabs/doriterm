import { CloseCode } from "@doriface/crypto";
import { parsePolicy } from "@doriface/policy";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MeshStore } from "../state/mesh.ts";
import { withStateLock } from "../state/lock.ts";
import { clearClientSessions, clients, connectClient, lastSeen } from "../testing/client-session-harness.ts";
import { CLIENT } from "../testing/gateway-harness.ts";
import { noiseOf } from "../testing/mesh-history.ts";
import { open, required } from "../testing/roster-resume-harness.ts";

afterEach(clearClientSessions);
const AT = 1_790_000_000_000;

test("a plan refusal after the handshake leaves the client's session time unchanged", async () => {
  const f = clients();
  f.a.mesh.recordClientSession(noiseOf(f.c.m), AT);
  const other = await open(f, "roster", f.other);
  const clock = spyOn(Date, "now").mockReturnValue(AT + 600_000);
  try {
    const dial = await connectClient(f, undefined, {
      policy: parsePolicy('{"plan":"free","limits":{"sessions":1}}'),
      beforeAdmission: () => {
        f.deps.live.add(required(other.host));
      },
    });
    expect(dial.hostEnd.closeCode).toBe(CloseCode.RateLimited);
    expect(lastSeen(f)).toBe(AT);
  } finally {
    clock.mockRestore();
  }
});

test("a roster card with a stale nonce cannot refresh the client's session time", async () => {
  const f = clients();
  f.a.mesh.recordClientSession(noiseOf(f.c.m), AT);
  const clock = spyOn(Date, "now").mockReturnValue(AT + 600_000);
  try {
    const dial = await connectClient(f, "roster", { card: (body) => ({ ...body, nonce: "stale" }) });
    expect(dial.reply).toBe("refused");
    expect(lastSeen(f)).toBe(AT);
  } finally {
    clock.mockRestore();
  }
});

test("a failed timestamp file write is logged while the admitted hc session remains usable", async () => {
  const f = clients();
  const uuid = "12345678-0000-4000-8000-000000000000";
  mkdirSync(join(f.a.dir, `mesh.json.${process.pid}.${uuid.slice(0, 8)}.tmp`));
  const random = spyOn(crypto, "randomUUID").mockReturnValue(uuid);
  try {
    const dial = await connectClient(f, undefined);
    expect(dial.error).toBeUndefined();
    expect(dial.hostEnd.closeCode).toBeUndefined();
    expect(f.a.logs.some((line) => line.includes("cannot record client session"))).toBe(true);
    required(dial.client).send(new TextEncoder().encode(CLIENT));
    await dial.pipe.reached;
    expect(dial.pipe.text()).toBe(CLIENT);
    expect(lastSeen(f)).toBeUndefined();
  } finally {
    random.mockRestore();
  }
});

test("a recent persisted session time avoids the state lock even after restart", () => {
  const f = clients();
  const key = noiseOf(f.c.m);
  f.a.mesh.recordClientSession(key, AT);
  const logs: string[] = [];
  const restarted = new MeshStore(f.a.dir, {
    lockTimeoutMs: 0,
    log: (line) => {
      logs.push(line);
    },
  });
  withStateLock(f.a.dir, () => {
    expect(() => restarted.recordClientSession(key, AT + 2000)).not.toThrow();
  });
  expect(logs).toEqual([]);
  expect(lastSeen(f, restarted)).toBe(AT);
  restarted.recordClientSession(key, AT + 300_000);
  expect(lastSeen(f, restarted)).toBe(AT + 300_000);
});
