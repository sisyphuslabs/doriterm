import type { HcConnection } from "@doriface/client";
import { generateX25519 } from "@doriface/crypto";
import { afterAll, describe, test } from "bun:test";
import { type RelayedHost, startRelayedHost } from "./support/relayed-host.ts";
import { socketFrom, testIp } from "./support/probe.ts";
import { setUpOnce } from "./support/set-up-once.ts";

// #424: the host ends a session's `hc connect` child two ways (it closes the child's stdin and sends SIGTERM), so a
// child is left behind only when both are skipped.
// #1995 (contract v1.11): a link that drops with no close handshake no longer ends the session. The host keeps it, child
// and all, for its client to resume on a new socket, and ends it as before only once that window has passed with no
// resume. The host here keeps a short window, so one test sees the child survive the drop and then end.

const END_BOUND_MS = 5_000;
/** How long this suite's host keeps a dropped session: long enough to be seen kept, short enough to be seen ending. */
const RESUME_GRACE_MS = 2_000;
/** A pid that is not this process's child has no exit event, so its exit is read by scanning again after this. */
const ROUND_MS = 50;
const CYCLES = 100;
/** Past END_BOUND_MS, so a child that outlives its bound fails on that, not on bun's default 5 s test timeout. */
const TEST_MS = 30_000;
/** Within the relay's 60 connects a minute from one IP (`CONNECT_LIMIT`), so the cycles are never refused 4429. */
const CONNECTS_PER_IP = 50;

const phone = generateX25519();
const sockets = { host: [] as WebSocket[], client: [] as WebSocket[] };
let relayed: RelayedHost | undefined;
const logWaiters: { readonly prefix: string; readonly resolve: () => void }[] = [];

/** Resolves on the host's next log line that starts with `prefix`; call it before the action that logs it. */
function nextHostLog(prefix: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  logWaiters.push({ prefix, resolve });
  return promise;
}
let clientIp: string | undefined;

function host(): RelayedHost {
  if (relayed === undefined) throw new Error("setup failed");
  return relayed;
}

/** Every running `hc connect` on this suite's hc session, by pid, with its parent's pid. */
async function liveConnects(): Promise<Map<number, number>> {
  const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,args="], { stdout: "pipe", stderr: "inherit" });
  const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (code !== 0) throw new Error(`ps exited ${code}`);
  const session = `connect --session ${host().session.name}`;
  return new Map(
    text
      .split("\n")
      .filter((line) => line.trimEnd().endsWith(session))
      .map((line) => {
        const [pid = "", ppid = ""] = line.trim().split(/\s+/, 2);
        return [Number.parseInt(pid, 10), Number.parseInt(ppid, 10)] as const;
      }),
  );
}

async function newSince(before: ReadonlyMap<number, number>): Promise<Set<number>> {
  return new Set([...(await liveConnects()).keys()].filter((pid) => !before.has(pid)));
}

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.byteLength >= prefix.byteLength && prefix.every((byte, index) => bytes[index] === byte);

/**
 * The session's own `hc connect`: of those started since `before`, the tapped one that read everything the session
 * sent, and the real hc under it. The host starts `hc connect` children of its own on the same hc session too (a fresh
 * one for its git facts every few seconds); one that starts while the session opens reads other bytes, ends on its own,
 * and must not be taken for the session's (#2397).
 */
async function childOf(before: ReadonlyMap<number, number>, sent: Uint8Array): Promise<Set<number>> {
  const live = await liveConnects();
  const fresh = [...live.keys()].filter((pid) => !before.has(pid));
  const tap = host()
    .taps()
    .find((each) => fresh.includes(Number(each.pid)) && startsWith(each.read, sent));
  if (tap === undefined) throw new Error("no hc connect started since the session opened has read what it sent");
  const tapped = Number(tap.pid);
  return new Set(fresh.filter((pid) => pid === tapped || live.get(pid) === tapped));
}

async function allGone(pids: ReadonlySet<number>, after: string): Promise<void> {
  const deadline = performance.now() + END_BOUND_MS;
  const round = async (): Promise<void> => {
    const live = await liveConnects();
    const left = [...pids].filter((pid) => live.has(pid));
    if (left.length === 0) return;
    if (performance.now() > deadline) {
      throw new Error(`after ${after}, hc connect ${left.join(", ")} still running after ${END_BOUND_MS} ms`);
    }
    await Bun.sleep(ROUND_MS);
    return round();
  };
  return round();
}

/** Every pid is still running: what a dropped session's child does while the host keeps the session for a resume. */
async function allLive(pids: ReadonlySet<number>, during: string): Promise<void> {
  const live = await liveConnects();
  const ended = [...pids].filter((pid) => !live.has(pid));
  if (ended.length > 0) throw new Error(`during ${during}, hc connect ${ended.join(", ")} ended instead of being kept`);
}

/**
 * Both halves of the resume contract after `drop`: the host logs that it kept the session (`detached`, armed before the
 * drop), the child is still running then and halfway through the window, and once the window has passed the child is
 * gone, as a dropped session's was before #1995.
 */
async function keptThenEnded(child: ReadonlySet<number>, detached: Promise<void>, drop: string): Promise<void> {
  await detached;
  await allLive(child, `${drop}, with the session kept for a resume`);
  await Bun.sleep(RESUME_GRACE_MS / 2);
  await allLive(child, `${drop}, halfway through the resume window`);
  await allGone(child, `${drop} and the resume window passed`);
}

async function openSession(): Promise<{ readonly connection: HcConnection; readonly child: Set<number> }> {
  const before = await liveConnects();
  const { connection, link } = await host().connectRecorded(phone);
  await connection.call("machine.list");
  return { connection, child: await childOf(before, link.sent) };
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-lifetime", {
    resumeGraceMs: RESUME_GRACE_MS,
    onLog: (line) => {
      for (const waiter of logWaiters.filter((each) => line.startsWith(each.prefix))) {
        logWaiters.splice(logWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    wrapSockets: (base) => ({
      host: (url) => {
        const ws = base(url);
        sockets.host.push(ws);
        return ws;
      },
      client: (url) => {
        const ws = clientIp === undefined ? base(url) : socketFrom(clientIp)(url);
        sockets.client.push(ws);
        return ws;
      },
    }),
  });
  await relayed.pair(phone, "lifetime");
  // The first pipe also starts the host's own long-lived children (#306), so no test counts them as a session's.
  const first = await relayed.connect(phone);
  await first.call("machine.list");
  first.close();
}, 120_000);

afterAll(async () => {
  await relayed?.stop();
});

describe("a client session's hc connect child (#424)", () => {
  test(
    "ends when the client closes its session",
    async () => {
      const { connection, child } = await openSession();
      connection.close();
      await allGone(child, "a clean close");
    },
    TEST_MS,
  );

  test(
    "survives the client's socket dropping with no close handshake, and ends once the resume window passes",
    async () => {
      const { child } = await openSession();
      const ws = sockets.client.at(-1) as (WebSocket & { terminate?: () => void }) | undefined;
      if (ws?.terminate === undefined) throw new Error("this runtime's WebSocket has no terminate()");
      const detached = nextHostLog("session detached");
      ws.terminate();
      await keptThenEnded(child, detached, "a dropped client socket");
    },
    TEST_MS,
  );

  test(`${CYCLES} sessions opened and closed leave no hc connect child behind`, async () => {
    const before = await liveConnects();
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      if (cycle % CONNECTS_PER_IP === 0) clientIp = testIp();
      // oxlint-disable-next-line no-await-in-loop -- one session at a time, as a phone reconnecting all day does
      const connection = await host().connect(phone);
      // oxlint-disable-next-line no-await-in-loop -- the call makes the session's hc connect child run before it closes
      await connection.call("machine.list");
      connection.close();
    }
    await allGone(await newSince(before), `${CYCLES} sessions`);
  }, 120_000);

  test(
    "survives the host's relay uplink dropping, and ends once the resume window passes",
    async () => {
      const { child } = await openSession();
      const uplink = sockets.host.at(-1);
      if (uplink === undefined) throw new Error("the host opened no uplink socket");
      const detached = nextHostLog("session detached");
      const answeredAgain = nextHostLog("relay: connected");
      uplink.close(4000, "test: uplink dropped");
      await keptThenEnded(child, detached, "a dropped uplink");
      // The next test opens a session through the relay, which refuses it while the host is offline (4404).
      await answeredAgain;
    },
    TEST_MS,
  );

  // Last: a revoked device can open no more sessions.
  test(
    "ends when the device is revoked, which ends its E2EE session",
    async () => {
      const { child } = await openSession();
      await host().revokeAll();
      await allGone(child, "a revoke");
    },
    TEST_MS,
  );
});
