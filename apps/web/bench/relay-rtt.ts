#!/usr/bin/env bun
// oxlint-disable no-await-in-loop -- each run is timed after the one before, as a person opens one tab after another
// Times the remote-session operations through a relay with a fixed injected round trip, against a real doriface-host on
// a scratch hc core, using the app's own client code, and prints one JSON line of samples:
//
//   bun apps/web/bench/relay-rtt.ts [--runs 50] [--rtt 145] [--gap 600] [--busy N] [--layout now|behind-attach|after-attach]
//                                   [--pipelined]
//
// The relay is the host package's FakeRelay behind a front that adds half of --rtt to every message in each direction,
// in order. The client stays connected like an open workspace: the event feed, and machine.list and the mesh document
// read every 10 s (MACHINE_REFRESH_MS). Each run then creates a terminal, attaches to it until its first output, and
// ends it. `--gap` is the pause between runs. Every request's send and reply time is kept, so a slow one can be laid
// beside what else was in flight.
//
// hc makes a run and a document write durable before it answers (an fsync; F_FULLFSYNC on macOS, which can take tens
// to hundreds of ms on a busy disk). To see what a slow flush does to the other calls, run the bench under strace with
// every fsync delayed, on Linux (#1351):
//
//   strace -f --seccomp-bpf -qq -e trace=fsync,fdatasync -e inject=fsync,fdatasync:delay_enter=60000 -o /dev/null \
//     bun apps/web/bench/relay-rtt.ts --layout now
import type { HcConnection, TerminalStream } from "@doriface/client";
import { startHost } from "@doriface/host";
import { createHcSession, FakeRelay } from "@doriface/host/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connect } from "../src/connection/connect.ts";
import type { RelayDeps } from "../src/connection/relay-deps.ts";
import { DEFAULT_SETTINGS } from "../src/connection/settings.ts";
import { base64urlEncode, generateX25519, rawStaticKey } from "@doriface/crypto";
import { pairWithHost } from "../src/pair/handshake.ts";
import { lookupCode } from "../src/pair/lookup.ts";
import { endSession, sessionCalls } from "../src/workspace/session-actions.ts";
import { MACHINE_REFRESH_MS } from "../src/workspace/use-machines.ts";
import { firstOutput } from "./remote-ops-stream.ts";
import { attachAhead, openingCallsOf, runWithAttach, takeOpeningAttach } from "../src/terminal/opening-attach.ts";
import { docCalls } from "../src/workspace/use-layout-docs.ts";
import { LAYOUT_DOC } from "@doriface/protocol/layout";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: "string", default: "50" },
    rtt: { type: "string", default: "145" },
    gap: { type: "string", default: "600" },
    busy: { type: "string", default: "0" },
    layout: { type: "string", default: "none" },
    pipelined: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
const oneWayMs = Number(values.rtt) / 2;
const gapMs = Number(values.gap);
const busyCount = Number(values.busy);
/**
 * `--layout now`: write the layout document as the page's LayoutDoc does when it places a new tab: at once, with the
 * version it last read, before the new pane's attach. `--layout behind-attach`: the same write right behind the attach,
 * both in flight. `--layout after-attach`: the write once the attach replied. `--layout app`: the page's own path for a
 * tab opened from the list (attachAhead, then docCalls' layout write).
 */
const writeLayout = values.layout;
let layoutVersion = 0;
const PAGE_DISPLAY = { fg: "#d8d4cb", bg: "#1f1d1a", cursor: "#d8d4cb" };
/** `--pipelined`: open each terminal as the page does since #1351, its attach sent right behind its run. */
const pipelined = values.pipelined;
const now = (): number => performance.now();
const t0 = now();

/** Delivers each message `oneWayMs` after it was handed over, never before an earlier one: a fixed-latency wire. */
function delayed(deliver: (bytes: Uint8Array | string) => void): (bytes: Uint8Array | string) => void {
  const queue: { readonly at: number; readonly bytes: Uint8Array | string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pump = (): void => {
    timer = undefined;
    while (queue.length > 0 && (queue[0]?.at ?? 0) <= now()) deliver(queue.shift()?.bytes ?? "");
    const next = queue[0];
    if (next !== undefined) timer = setTimeout(pump, Math.max(0, next.at - now()));
  };
  return (bytes) => {
    queue.push({ at: now() + oneWayMs, bytes: typeof bytes === "string" ? bytes : bytes.slice() });
    timer ??= setTimeout(pump, oneWayMs);
  };
}

const relay = new FakeRelay();
let nextSession = 100;
interface Client {
  readonly pairSlot: string | undefined;
  send?: (bytes: Uint8Array | string) => void;
  close?: () => void;
}
const front = Bun.serve<Client>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => {
    const url = new URL(request.url);
    const [, , kind, rest = ""] = url.pathname.split("/");
    if (kind === "pair") {
      const record = relay.pairLookup(rest);
      return record === undefined ? new Response("not found", { status: 404 }) : Response.json(record);
    }
    const data: Client = { pairSlot: url.searchParams.get("pair") ?? undefined };
    return server.upgrade(request, { data }) ? undefined : new Response("upgrade", { status: 426 });
  },
  websocket: {
    open: (ws) => {
      const session = relay.open(nextSession++, ws.data.pairSlot);
      const toClient = delayed((bytes) => ws.send(bytes));
      session.onData((bytes) => toClient(bytes));
      void session.closed.then((code) => ws.close(code, ""));
      const toHost = delayed((bytes) => {
        if (typeof bytes !== "string") session.send(bytes);
      });
      ws.data.send = toHost;
      ws.data.close = () => session.close();
    },
    message: (ws, message) => {
      if (typeof message !== "string") ws.data.send?.(message);
    },
    close: (ws) => ws.data.close?.(),
  },
});
const relayUrl = `http://127.0.0.1:${front.port ?? 0}`;

const stateDir = mkdtempSync(join(tmpdir(), "relay-rtt-"));
const hc = createHcSession("relay-rtt");
const host = await startHost({
  listen: { hostname: "127.0.0.1", port: 0 },
  token: `relay-rtt-${crypto.randomUUID()}`,
  hc: hc.hc,
  session: hc.name,
  env: { ...hc.env, PS1: "$ " },
  stateDir,
  relay: { url: relay.url },
  log: () => {},
});

async function stop(): Promise<void> {
  await host.stop().catch(() => undefined);
  await hc.dispose().catch(() => undefined);
  await front.stop(true);
  await relay.stop();
  rmSync(stateDir, { recursive: true, force: true });
}

/** Every request this run made: method, send and reply times (ms since start). */
const calls: { readonly method: string; readonly sent: number; readonly replied: number }[] = [];
const samples: Record<string, number[]> = {};
const note = (op: string, ms: number): void => {
  (samples[op] ??= []).push(Math.round(ms * 10) / 10);
};

try {
  await relay.answers.next();
  const CLI = join(import.meta.dir, "..", "..", "host", "src", "cli.ts");
  const pair = Bun.spawn([process.execPath, CLI, "pair", "--no-qr", "--relay", relayUrl, "--state-dir", stateDir], {
    stdout: "pipe",
  });
  const typed = /^code\s+(\S{4}) (\S{4})$/m.exec(await new Response(pair.stdout).text());
  if ((await pair.exited) !== 0 || typed === null) throw new Error("doriface-host pair printed no code");
  const parsed = await lookupCode(`${typed[1]}${typed[2]}`, relayUrl);
  if (!parsed.ok) throw new Error(`lookup: ${parsed.reason}`);
  const device = rawStaticKey(generateX25519());
  const deps: RelayDeps = { loadDeviceKey: async () => device };
  (await pairWithHost(parsed.offer, "relay-rtt", deps)).connection.close();
  const key = base64urlEncode(parsed.offer.noiseStaticPub);
  const settings = {
    ...DEFAULT_SETTINGS,
    relayUrl,
    hostId: parsed.offer.hostId,
    hostKey: key,
    members: [{ hostId: parsed.offer.hostId, hostName: "", hostKey: key, directUrl: "" }],
  };
  const opened = await connect(settings, undefined, deps);
  const connection: HcConnection = opened.connection;
  const timedCall = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
    const sent = now();
    const value = await run();
    calls.push({ method, sent: sent - t0, replied: now() - t0 });
    return value;
  };
  // The open workspace: its feed, and machine.list on the page's timer.
  const feed = await connection.subscribe();
  const refresh = setInterval(() => {
    void timedCall("machine.list", () => connection.call("machine.list"));
    void timedCall("doc.get", () => connection.call("doc.get", { name: "doriface-mesh" }));
  }, MACHINE_REFRESH_MS);
  // `--busy N`: N open panes whose programs print without pause, each viewed like a visible pane (credit returned as
  // output arrives), as a workspace with an agent at work is.
  const busy: TerminalStream[] = [];
  for (let i = 0; i < busyCount; i += 1) {
    const { address } = await connection.call("terminal.run", { line: "while :; do seq 1 400; sleep 0.02; done" });
    busy.push(await connection.attach({ terminal: address, cols: 120, rows: 32 }));
  }
  // Warm-up: one full round, not counted.
  for (let run = -1; run < runs; run += 1) {
    const started = now();
    const { address } = await timedCall("terminal.run", () =>
      pipelined
        ? runWithAttach(connection, openingCallsOf(connection), {}, undefined)
        : connection.call("terminal.run", {}),
    );
    const early = pipelined ? takeOpeningAttach(connection, address)?.stream : undefined;
    const createdAt = now();
    const placeTab = async (): Promise<void> => {
      const set = await timedCall("doc.set", () =>
        connection.call("doc.set", { name: LAYOUT_DOC, value: { v: 1, tabs: [address] }, version: layoutVersion }),
      );
      layoutVersion = set.version;
    };
    // The page's own path for a tab opened from the list: the attach first, then the layout write through docCalls.
    if (writeLayout === "app") attachAhead(connection, openingCallsOf(connection), address, PAGE_DISPLAY);
    const appWrite = async (): Promise<void> => {
      const set = await timedCall("doc.set", () =>
        docCalls(connection, () => []).set(null, { v: 1, tabs: [address] }, layoutVersion),
      );
      layoutVersion = set.version;
    };
    let layout = writeLayout === "now" ? placeTab() : writeLayout === "app" ? appWrite() : undefined;
    const ahead = writeLayout === "app" ? takeOpeningAttach(connection, address)?.stream : undefined;
    let stream: TerminalStream | undefined;
    try {
      const attachStarted = pipelined ? started : now();
      const attaching = timedCall(
        "terminal.attach",
        () => early ?? ahead ?? connection.attach({ terminal: address, cols: 120, rows: 32, history: 2000 }),
      );
      if (writeLayout === "behind-attach") layout = placeTab();
      stream = await attaching;
      const replied = now();
      if (writeLayout === "after-attach") layout = placeTab();
      const paint = await firstOutput(stream, attachStarted, 10_000);
      if (run >= 0) {
        note("create", createdAt - started);
        note("attach.reply", replied - attachStarted);
        note("attach.first_paint", paint);
        note("open.total", now() - started);
      }
      await layout;
      const listed = now();
      await timedCall("terminal.list", () => connection.call("terminal.list", { all: true }));
      if (run >= 0) note("list", now() - listed);
    } finally {
      await stream?.close().catch(() => undefined);
      await endSession(sessionCalls(connection), address).catch(() => undefined);
    }
    await Bun.sleep(gapMs);
  }
  clearInterval(refresh);
  for (const stream of busy) await stream.close().catch(() => undefined);
  feed.close();
  connection.close();
} finally {
  await stop();
}

const pct = (list: readonly number[], p: number): number => {
  const sorted = list.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
};
const summary = Object.fromEntries(
  Object.entries(samples).map(([op, list]) => [
    op,
    { n: list.length, p50: pct(list, 50), p95: pct(list, 95), max: Math.max(...list) },
  ]),
);
process.stdout.write(
  `${JSON.stringify({ rttMs: oneWayMs * 2, runs, gapMs, busy: busyCount, layout: writeLayout, pipelined, summary, samples, calls })}\n`,
);
process.exit(0);
