#!/usr/bin/env bun
// Times what the desktop app does with a remote machine reached through the relay, using the app's own client code
// (apps/web connect(), pairWithHost(), endSession() and the client SDK under them), and prints one JSON line.
//
//   bun apps/web/bench/remote-ops.ts pair --code <code> [--relay <url>]
//     One typed-code pairing as the Add machine screen runs it: lookup, pairing session, then the workspace's first
//     calls on that same session (the app opens its workspace on the session the pairing proved).
//   bun apps/web/bench/remote-ops.ts ops --code <code> [--relay <url>] [--runs 30]
//     Pairs one device with that code, then repeats the session operations `--runs` times on it.
//   bun apps/web/bench/remote-ops.ts pair-staged --code <code> [--relay <url>]
//     The pairing in stages: the lookup twice (first and repeat), then socket, handshake and hello.
//
// Every sample is milliseconds of wall time on the client. Stage samples (`*.socket`, `*.noise`, `*.hello`) split a
// connect into the relay socket, the Noise IK handshake and hc's framed hello. The line carries the run's mode, relay
// URL and start time, the samples, and each failed step's error message (which may name the relay path and host id).
// Whatever a round opens (sockets, sessions, feeds, streams, the terminal it started) is closed or ended on every path.
import { HcConnection, type TerminalStream } from "@doriface/client";
import { base64urlDecode, base64urlEncode, generateX25519, rawStaticKey, secureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { parseArgs } from "node:util";
import { connect } from "../src/connection/connect.ts";
import type { RelayDeps } from "../src/connection/relay-deps.ts";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "../src/connection/settings.ts";
import { pairWithHost } from "../src/pair/handshake.ts";
import { slotOf } from "../src/pair/code.ts";
import { lookupCode } from "../src/pair/lookup.ts";
import { endSession, sessionCalls } from "../src/workspace/session-actions.ts";
import { onLink } from "./remote-ops-link.ts";
import { echo, firstOutput, inTurn, quiet } from "./remote-ops-stream.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    code: { type: "string" },
    relay: { type: "string", default: DEFAULT_SETTINGS.relayUrl },
    runs: { type: "string", default: "30" },
  },
});
const mode = positionals[0];
const code = values.code;
const runs = Number(values.runs);
if (
  (mode !== "pair" && mode !== "ops" && mode !== "pair-staged") ||
  code === undefined ||
  !Number.isInteger(runs) ||
  runs < 1
) {
  process.stderr.write("usage: remote-ops.ts pair|ops|pair-staged --code <code> [--relay <url>] [--runs N, N >= 1]\n");
  process.exit(2);
}
const relayUrl = values.relay;
const samples: Record<string, number[]> = {};
const failures: Record<string, string[]> = {};
const note = (op: string, ms: number): void => {
  (samples[op] ??= []).push(Math.round(ms * 10) / 10);
};
const failed = (op: string, error: unknown): void => {
  (failures[op] ??= []).push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
};
const now = (): number => performance.now();

async function timed<T>(op: string, run: () => Promise<T>): Promise<T> {
  const started = now();
  const value = await run();
  note(op, now() - started);
  return value;
}

/** One device's static key, as the browser's device-key store would hand it out. */
const device = rawStaticKey(generateX25519());
const deps: RelayDeps = { loadDeviceKey: async () => device };

let paired: HcConnection | undefined;

async function pairOnce(): Promise<ConnectionSettings> {
  const started = now();
  const parsed = await timed("pair.lookup", () => lookupCode(code ?? "", relayUrl));
  if (!parsed.ok) throw new Error(`lookup: ${parsed.reason}`);
  const { offer } = parsed;
  paired = (await timed("pair.session", () => pairWithHost(offer, "remote-ops-bench", deps))).connection;
  note("pair.total", now() - started);
  return {
    ...DEFAULT_SETTINGS,
    relayUrl,
    hostId: offer.hostId,
    hostKey: base64urlEncode(offer.noiseStaticPub),
    members: [{ hostId: offer.hostId, hostName: "", hostKey: base64urlEncode(offer.noiseStaticPub), directUrl: "" }],
  };
}

/** The app's connect, as the workspace runs it for a relay member with no direct address. */
async function appConnect(settings: ConnectionSettings, op: string): Promise<HcConnection> {
  const opened = await timed(op, () => connect(settings, undefined, deps));
  if (opened.path !== "relay") throw new Error(`expected the relay path, got ${opened.path}`);
  return opened.connection;
}

/** The same connect in its three stages, to see where the time goes. */
async function stagedConnect(settings: ConnectionSettings): Promise<void> {
  const started = now();
  // One socket: this connect is timed in stages and closed, and nothing on it gains from a nearer ingress (#1418).
  const link = await timed("connect.socket", () =>
    connectRelayClient({ relayUrl, hostId: settings.hostId, bestOf: 1 }),
  );
  await onLink(link, async () => {
    const secure = await timed("connect.noise", () =>
      secureLink(link, {
        role: "initiator",
        hostId: settings.hostId,
        staticKey: device,
        remoteStatic: base64urlDecode(settings.hostKey),
      }),
    );
    const connection = await timed("connect.hello", () => HcConnection.open(secure));
    note("connect.staged", now() - started);
    connection.close();
  });
}

/** What the workspace asks for as it opens: the terminal list, the event feed and the machine list, in parallel. */
async function listWorkspace(connection: HcConnection, started: number): Promise<void> {
  const feed = connection.subscribe();
  try {
    await Promise.all([
      timed("workspace.terminal.list", () => connection.call("terminal.list", { all: true })),
      timed("workspace.subscribe", () => feed),
      timed("workspace.machine.list", () => connection.call("machine.list")),
    ]);
    note("workspace.open", now() - started);
  } finally {
    void feed.then(
      (opened) => opened.close(),
      () => undefined,
    );
  }
}

/** The workspace on a fresh connect; the connection is closed when its first calls fail. */
async function openWorkspace(settings: ConnectionSettings): Promise<HcConnection> {
  const started = now();
  const connection = await appConnect(settings, "workspace.connect");
  try {
    await listWorkspace(connection, started);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

async function sessionRound(connection: HcConnection): Promise<void> {
  await timed("ping.server.status", () => connection.call("server.status"));
  await timed("list.terminals", () => connection.call("terminal.list", { all: true }));
  await timed("list.machines", () => connection.call("machine.list"));
  const { address } = await timed("create.terminal.run", () => connection.call("terminal.run", {}));
  let stream: TerminalStream | undefined;
  try {
    await timed("list.after_create", () => connection.call("terminal.list", { all: true }));
    const attachStarted = now();
    const attached = await timed("attach.reply", () =>
      connection.attach({ terminal: address, cols: 120, rows: 32, history: 2000 }),
    );
    stream = attached;
    note("attach.first_paint", await firstOutput(attached, attachStarted, 10_000));
    await quiet(attached, 400, 5000);
    await inTurn(["q", "z", "x"], (char) =>
      step("type.echo", async () => note("type.echo", await echo(attached, char, 5000))),
    );
    attached.write("\u0015");
  } finally {
    // The terminal this round started ends whatever failed, so no run leaves one behind for the next to measure beside.
    await step("close.end_session", () =>
      timed("close.end_session", () => endSession(sessionCalls(connection), address)),
    );
    await stream?.close().catch(() => undefined);
  }
}

async function step(op: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failed(op, error);
  }
}

async function stagedPair(): Promise<void> {
  const parsed = await timed("pair.lookup", () => lookupCode(code ?? "", relayUrl));
  if (!parsed.ok) throw new Error(`lookup: ${parsed.reason}`);
  await timed("pair.lookup.repeat", () => lookupCode(code ?? "", relayUrl));
  const { offer } = parsed;
  if (offer.secret.mode !== "code") throw new Error("expected a code offer");
  const link = await timed("pair.socket", () =>
    connectRelayClient({ relayUrl, hostId: offer.hostId, pairSlot: slotOf(code ?? "") }),
  );
  await onLink(link, async () => {
    const secure = await timed("pair.noise", () =>
      secureLink(link, {
        role: "initiator",
        hostId: offer.hostId,
        staticKey: device,
        remoteStatic: offer.noiseStaticPub,
        pairing: { mode: "code", code: code ?? "", name: "remote-ops-bench" },
      }),
    );
    const connection = await timed("pair.hello", () => HcConnection.open(secure));
    connection.close();
  });
}

const startedAt = new Date().toISOString();
if (mode === "pair-staged") {
  await step("pair-staged", stagedPair);
} else if (mode === "pair") {
  await step("pair", async () => {
    await pairOnce();
    const connection = paired;
    if (connection === undefined) throw new Error("pairing returned no session");
    const started = now();
    try {
      await listWorkspace(connection, started);
      note("pair.to_workspace", now() - started + (samples["pair.total"]?.at(-1) ?? 0));
    } finally {
      connection.close();
    }
  });
} else {
  let settings: ConnectionSettings | undefined;
  await step("pair", async () => {
    settings = await pairOnce();
  });
  paired?.close();
  const round = async (host: ConnectionSettings): Promise<void> => {
    await step("connect.staged", () => stagedConnect(host));
    let connection: HcConnection | undefined;
    await step("workspace", async () => {
      connection = await openWorkspace(host);
    });
    if (connection === undefined) return;
    const open = connection;
    try {
      await step("session", () => sessionRound(open));
    } finally {
      open.close();
    }
  };
  const target = settings;
  if (target !== undefined)
    await inTurn(
      Array.from({ length: runs }, (_, run) => run),
      () => round(target),
    );
}
process.stdout.write(`${JSON.stringify({ mode, relayUrl, startedAt, samples, failures })}\n`);
process.exit(0);
