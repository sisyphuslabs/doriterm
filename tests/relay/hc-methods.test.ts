import type { EventFeed, HcConnection } from "@doriface/client";
import { encodeFrame, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
import { generateX25519 } from "@doriface/crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ByteReader } from "../../apps/host/src/testing/byte-reader.ts";
import { HELLO } from "../../apps/host/src/testing/hc-session.ts";
import { type RecordingLink, replyDifference, requestDifference, type Tap, tapFor } from "./support/byte-tap.ts";
import { type RelayedHost, startRelayedHost } from "./support/relayed-host.ts";
import { type EventWatch, watchEvents, watchScreen, within } from "./support/watch.ts";
import { setUpOnce } from "./support/set-up-once.ts";

const phone = generateX25519();
let relayed: RelayedHost | undefined;
let connection: HcConnection | undefined;
let recorded: RecordingLink | undefined;
let feed: EventFeed | undefined;
let watched: EventWatch | undefined;

const text = (base64: string): string => Buffer.from(base64, "base64").toString("utf8");

function started(): { readonly hc: HcConnection; readonly events: EventWatch; readonly dir: string } {
  if (relayed === undefined || connection === undefined || watched === undefined) throw new Error("setup failed");
  return { hc: connection, events: watched, dir: join(relayed.scratch, "work") };
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-methods");
  mkdirSync(join(relayed.scratch, "work"));
  await relayed.pair(phone, "methods");
  ({ connection, link: recorded } = await relayed.connectRecorded(phone));
  feed = await connection.subscribe();
  watched = watchEvents(feed);
}, 120_000);

afterAll(async () => {
  feed?.close();
  connection?.close();
  await relayed?.stop();
});

const encoder = new TextEncoder();
const request = (id: number, method: string, params: object): Uint8Array =>
  encodeFrame(RPC_CHANNEL, FrameKind.Data, encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
/** Replies whose bytes do not depend on time or on what other tests did. */
const STABLE: readonly [string, object][] = [
  ["templates.list", {}],
  ["rpc.discover", {}],
  ["machine.list", {}],
  ["doc.get", { name: "never-written" }],
  ["terminal.get", { terminal: "t999" }],
];

async function replies(write: (bytes: Uint8Array) => void | Promise<void>, reader: ByteReader): Promise<Uint8Array[]> {
  await write(HELLO);
  const hello = await reader.line();
  const next = async (index: number, out: Uint8Array[]): Promise<Uint8Array[]> => {
    const call = STABLE[index];
    if (call === undefined) return out;
    await write(request(index + 1, call[0], call[1]));
    return next(index + 1, [...out, await reader.frame()]);
  };
  return next(0, [hello]);
}

describe("every hc method family, client SDK -> Noise IK -> relay -> doriface-host -> hc", () => {
  test("terminal.run, list, get, attach (typing), send, keys, read, label, kill and rm, with their events", async () => {
    const { hc, events, dir } = started();
    const run = await hc.call("terminal.run", { argv: ["/bin/sh"], cwd: dir, env: { PS1: "$ ", HOME: dir } });
    const address = run.address;
    expect((await events.next("created", address)).terminal).toBe(address);
    expect((await hc.call("terminal.list")).terminals.map((terminal) => terminal.address)).toContain(address);
    const got = await hc.call("terminal.get", { terminal: address });
    expect([got.address, got.state]).toEqual([address, "live"]);

    const stream = await hc.attach({ terminal: address, cols: 100, rows: 30 });
    const screen = watchScreen(stream);
    stream.write("echo typed-$((40 + 2))\r");
    await screen.line("typed-42");
    await hc.call("terminal.send", { terminal: address, text: "echo sent-$((1 + 1))" });
    await screen.line("sent-2");
    await hc.call("terminal.keys", { terminal: address, keys: ["e", "c", "h", "o", "space", "k", "9", "enter"] });
    await screen.line("k9");
    const read = await hc.call("terminal.read", { terminal: address });
    expect(read.text.split("\n").map((line) => line.trim())).toEqual(expect.arrayContaining(["sent-2", "k9"]));

    const labelled = await hc.call("terminal.label", { terminal: address, labels: { suite: "relay" } });
    expect(labelled.labels).toEqual({ suite: "relay" });
    expect((await events.next("labels", address)).data).toMatchObject({ labels: { suite: "relay" } });

    const closed = within(new Promise((resolve) => stream.onClose(resolve)), "the attach stream closing");
    const killed = await hc.call("terminal.kill", { terminal: address });
    expect(killed.state).toBe("finished");
    await events.next("finished", address);
    expect(await closed).toMatchObject({ by: "core", reason: "killed" });
    expect((await hc.call("terminal.rm", { terminal: address })).removed).toBe(address);
    await events.next("removed", address);
  }, 60_000);

  test("terminal.wait returns the exit of a program that finished", async () => {
    const { hc, events, dir } = started();
    const run = await hc.call("terminal.run", { argv: ["/bin/sh", "-c", "exit 3"], cwd: dir, keep: false });
    const waited = await hc.call("terminal.wait", { terminal: run.address, timeout: 15 });
    expect([waited.ended, waited.exit_code]).toEqual([true, 3]);
    await events.next("finished", run.address);
  }, 30_000);

  test("machine.exec runs a command and returns its exit, stdout and stderr", async () => {
    const { hc, dir } = started();
    const exec = await hc.call("machine.exec", {
      argv: ["/bin/sh", "-c", "printf exec-ok; printf exec-err >&2; exit 4"],
      cwd: dir,
    });
    expect([exec.code, text(exec.stdout), text(exec.stderr), exec.timed_out]).toEqual([
      4,
      "exec-ok",
      "exec-err",
      false,
    ]);
  }, 30_000);

  test("file.write, file.read and file.edit change a real file on the host", async () => {
    const { hc, dir } = started();
    const path = join(dir, "note.txt");
    const data = Buffer.from("alpha\nbeta\n").toString("base64");
    expect((await hc.call("file.write", { path, data })).bytes).toBe(11);
    expect((await hc.call("file.read", { path })).text).toContain("beta");
    await hc.call("file.edit", { path, edits: [{ old: "beta", new: "gamma" }] });
    expect(readFileSync(path, "utf8")).toBe("alpha\ngamma\n");
    expect((await hc.call("file.read", { path })).text).toContain("gamma");
  }, 30_000);

  test("doc.set and doc.get round-trip a versioned document, and subscribers hear of it", async () => {
    const { hc, events } = started();
    const name = `relay-doc-${crypto.randomUUID().slice(0, 8)}`;
    expect((await hc.call("doc.get", { name })).version).toBe(0);
    const set = await hc.call("doc.set", { name, value: { panes: ["t1"] }, version: 0 });
    expect(set.version).toBe(1);
    expect(await hc.call("doc.get", { name })).toEqual({ value: { panes: ["t1"] }, version: 1 });
    expect((await events.next("doc")).data).toMatchObject({ name, version: 1 });
  }, 30_000);

  test("machine.list and rpc.discover answer through the relay", async () => {
    const { hc } = started();
    expect((await hc.call("machine.list")).machines).toEqual([]);
    const discovered: unknown = await hc.call("rpc.discover");
    const methods =
      typeof discovered === "object" && discovered !== null && "methods" in discovered ? discovered.methods : [];
    const names = Array.isArray(methods)
      ? methods.map((method: unknown) =>
          typeof method === "object" && method !== null && "name" in method ? method.name : undefined,
        )
      : [];
    expect(names).toEqual(expect.arrayContaining([...hc.hello.methods]));
  }, 30_000);

  test("server.status names the core hello named, and templates.list answers", async () => {
    const { hc } = started();
    const status = await hc.call("server.status");
    expect([status.core.id, status.version]).toEqual([hc.hello.core.id, hc.hello.version]);
    expect(status.pid).toBeGreaterThan(0);
    expect(status.live).toBeGreaterThanOrEqual(0);
    expect(Array.isArray((await hc.call("templates.list")).templates)).toBe(true);
  }, 30_000);

  test("terminal.keep marks a terminal kept, and its keep event follows", async () => {
    const { hc, events, dir } = started();
    const run = await hc.call("terminal.run", { argv: ["/bin/sh"], cwd: dir });
    expect((await hc.call("terminal.keep", { terminal: run.address, keep: true })).keep).toBe(true);
    expect((await events.next("keep", run.address)).data).toEqual({ keep: true });
    await hc.call("terminal.kill", { terminal: run.address });
  }, 30_000);

  test("terminal.interrupt presses ctrl+c, and the program's INT trap ends it with exit 0", async () => {
    const { hc, events, dir } = started();
    const script = "trap 'echo interrupted; exit 0' INT; echo armed; while :; do sleep 1; done";
    const run = await hc.call("terminal.run", { argv: ["/bin/sh", "-c", script], cwd: dir });
    const screen = watchScreen(await hc.attach({ terminal: run.address, cols: 80, rows: 24 }));
    await screen.contains("armed");
    const interrupted = await hc.call("terminal.interrupt", { terminal: run.address, timeout: 1 });
    expect(interrupted.key).toBe("ctrl+c");
    expect((await events.next("finished", run.address)).data).toMatchObject({ exit_code: 0 });
    expect((await hc.call("terminal.read", { terminal: run.address })).text).toContain("interrupted");
  }, 30_000);

  test("terminal.put writes bytes into a file beside a live terminal", async () => {
    const { hc, dir } = started();
    const run = await hc.call("terminal.run", { argv: ["/bin/sh"], cwd: dir });
    const put = await hc.call("terminal.put", {
      terminal: run.address,
      name: "pasted.txt",
      data: Buffer.from("put-through-relay").toString("base64"),
    });
    expect([put.bytes, put.path.endsWith("pasted.txt")]).toEqual([17, true]);
    expect(readFileSync(put.path, "utf8")).toBe("put-through-relay");
    await hc.call("terminal.kill", { terminal: run.address });
  }, 30_000);

  test("hello and replies that do not change are byte-identical through the relay and from a direct hc connect", async () => {
    if (relayed === undefined) throw new Error("setup failed");
    const link = await relayed.dial(phone);
    const viaRelay = new ByteReader();
    link.onData((bytes) => viaRelay.push(bytes));
    const relayedReplies = await within(
      replies((bytes) => link.send(bytes), viaRelay),
      "the relayed replies",
    );
    link.close();
    const direct = relayed.session.connect();
    const directReplies = await within(
      replies((bytes) => direct.write(bytes), direct.reader),
      "the direct replies",
    );
    direct.end();
    await direct.exited;
    expect(relayedReplies.map((bytes) => new TextDecoder().decode(bytes))).toEqual(
      directReplies.map((bytes) => new TextDecoder().decode(bytes)),
    );
  }, 30_000);

  test("every byte of this suite's session reached hc unchanged but a run's OSC 7577 token, and every byte hc wrote reached the client unchanged", async () => {
    const { hc } = started();
    if (relayed === undefined || recorded === undefined || feed === undefined) throw new Error("setup failed");
    feed.close();
    // hc reads its input in order, so once it answered this call it has read every byte sent before it.
    await hc.call("terminal.list");
    const link = recorded;
    const tap = tapFor(relayed.taps(), link.sent);
    if (tap === undefined) throw new Error("no tap holds this session's bytes");
    // The whole reply stream, not a prefix of it: once the client holds at least every byte hc has written, both sides
    // are read at that same moment and compared in full. A host that dropped bytes hc wrote never lets the client catch
    // up, so this waits out instead of passing.
    const snapshot = (): { readonly tap: Tap; readonly received: Uint8Array } | undefined => {
      const now = relayed?.taps().find((each) => each.pid === tap.pid);
      const received = link.received;
      return now !== undefined && received.byteLength >= now.wrote.byteLength ? { tap: now, received } : undefined;
    };
    const caughtUp = await within(
      new Promise<{ readonly tap: Tap; readonly received: Uint8Array }>((resolve) => {
        const ready = snapshot();
        if (ready !== undefined) return resolve(ready);
        const off = link.onData(() => {
          const next = snapshot();
          if (next === undefined) return;
          off();
          resolve(next);
        });
      }),
      "every byte hc wrote reaching the client",
    );
    expect(requestDifference(link.sent, caughtUp.tap.read)).toBeUndefined();
    expect(replyDifference(caughtUp.tap, caughtUp.received)).toBeUndefined();
    expect(caughtUp.received.byteLength).toBeGreaterThan(10_000);
  }, 30_000);
});
