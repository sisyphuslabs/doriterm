import { describe, expect, test } from "bun:test";
import { createMemoryLinkPair, HcConnection } from "@doriface/client";
import { encodeFrame, FrameDecoder, FrameKind, LineDecoder, RPC_CHANNEL } from "@doriface/protocol";
import { startTerminal } from "../workspace/start-on.ts";
import { docCalls } from "../workspace/use-layout-docs.ts";
import { attachAhead, openingCallsOf, openingTerminal, runWithAttach, viewAttach } from "./opening-attach.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const METHODS = [
  "hello",
  "terminal.run",
  "terminal.list",
  "terminal.get",
  "terminal.kill",
  "terminal.label",
  "terminal.attach",
  "terminal.read",
  "terminal.keys",
  "doc.get",
  "doc.set",
  "events.subscribe",
  "machine.list",
];
const HELLO_REPLY = JSON.stringify({
  id: 0,
  jsonrpc: "2.0",
  result: {
    core: { id: "0".repeat(32), name: "example-host" },
    features: ["framed", "attach", "events", "status", "shell"],
    framed: true,
    generation: 1,
    methods: METHODS,
    version: "0.1.17",
  },
});
const TERMINAL = {
  argv: ["/bin/sh"],
  cols: 100,
  created_ms: 1700000000000,
  cwd: "/home/example/work",
  die_with_parent: false,
  exit_code: null,
  finished_ms: null,
  foreground: { argv: ["/bin/sh"], cwd: "/home/example/work", name: "bash", pid: 4242 },
  identity: "ghostty",
  keep: false,
  labels: { capture: "doriface" },
  notify: true,
  parent: null,
  pid: 4242,
  reason: null,
  reported: false,
  rm: false,
  rows: 30,
  screen: "exact",
  signal: null,
  state: "live",
  status: null,
  status_ms: null,
  template: null,
  title: "",
  turn: 0,
};
const DISPLAY = { fg: "#000000", bg: "#ffffff", cursor: "#000000" };

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A core on the far end of an in-memory link: it records each request as it arrives and answers only when told to. */
class ScriptedCore {
  readonly requests: Request[] = [];
  readonly #send: (bytes: Uint8Array) => void;
  readonly #arrived = new Set<() => void>();

  constructor(core: ReturnType<typeof createMemoryLinkPair>[1]) {
    const lines = new LineDecoder();
    const frames = new FrameDecoder();
    let framed = false;
    this.#send = (bytes) => core.send(bytes);
    core.onData((chunk) => {
      let rest = chunk;
      if (!framed) {
        if (lines.push(chunk, 1)[0] === undefined) return;
        framed = true;
        core.send(encoder.encode(`${HELLO_REPLY}\n`));
        rest = lines.takeBuffered();
      }
      for (const frame of frames.push(rest)) {
        if (frame.channel === RPC_CHANNEL && frame.kind === FrameKind.Data) {
          this.requests.push(JSON.parse(decoder.decode(frame.payload)));
        }
      }
      for (const wake of this.#arrived) wake();
    });
  }

  request(method: string, nth = 0): Promise<Request> {
    return new Promise((resolve) => {
      const check = (): void => {
        const found = this.requests.filter((request) => request.method === method)[nth];
        if (found === undefined) return;
        this.#arrived.delete(check);
        resolve(found);
      };
      this.#arrived.add(check);
      check();
    });
  }

  reply(id: number, outcome: { readonly result: object } | { readonly error: object }): void {
    const text = JSON.stringify({ jsonrpc: "2.0", id, ...outcome });
    this.#send(encodeFrame(RPC_CHANNEL, FrameKind.Data, encoder.encode(text)));
  }
}

async function opened(): Promise<{ readonly connection: HcConnection; readonly core: ScriptedCore }> {
  const [client, far] = createMemoryLinkPair();
  const core = new ScriptedCore(far);
  return { connection: await HcConnection.open(client), core };
}

const attachedAgain = (): never => {
  throw new Error("the view attached again");
};

const notFound = { code: -32000, message: "no terminal", data: { kind: "not_found" } };

describe("openingTerminal", () => {
  test("names a run on this machine in the page's prefix, and an added machine's under it", () => {
    const here = openingTerminal({});
    const there = openingTerminal({ on: "build-box" });
    if (here === null || there === null) throw new Error("a run the page names has an opening");
    expect(here.name).toMatch(/^opened-[0-9a-f]{12}$/);
    expect(here.address).toBe(here.name);
    expect(here.machine).toBeNull();
    expect(there.name).toMatch(/^opened-[0-9a-f]{12}$/);
    expect(there.address).toBe(`build-box/${there.name}`);
    expect(there.machine).toBe("build-box");
    expect(there.name).not.toBe(here.name);
  });

  test("a run the caller named has no opening: its address is only its answer's", () => {
    expect(openingTerminal({ argv: ["claude"], name: "claude" })).toBeNull();
  });
});

describe("a new terminal's attach goes with its run (#1351)", () => {
  test("the attach naming the new terminal is on the wire before the run has answered: one round trip, not two", async () => {
    const { connection, core } = await opened();
    const started = startTerminal(
      (run) => runWithAttach(connection, openingCallsOf(connection), run, DISPLAY),
      { on: "build-box" },
      { name: "example-host", shown: () => [] },
    );
    const run = await core.request("terminal.run");
    const attach = await core.request("terminal.attach");
    expect(core.requests.map((request) => request.method)).toEqual(["terminal.run", "terminal.attach"]);
    const name = String(run.params["name"]);
    expect(attach.params["terminal"]).toBe(`build-box/${name}`);
    core.reply(run.id, { result: { ...TERMINAL, address: "build-box/t7", name } });
    core.reply(attach.id, { result: { channel: 2, terminal: { ...TERMINAL, address: "build-box/t7", name } } });
    expect(await started).toEqual({ ok: true, address: "build-box/t7" });
    const viewed = await viewAttach(
      connection,
      "build-box/t7",
      true,
      { cols: 100, rows: 30, display: DISPLAY },
      attachedAgain,
    );
    expect(viewed.stream.channel).toBe(2);
    // A terminal this page just started has no history for its first paint to walk: it is not held (#1928).
    expect(viewed.fresh).toBe(true);
    connection.close();
  });

  test("a view attaches on its own when the attach sent with the run was refused, as by a host that does not hold it", async () => {
    const { connection, core } = await opened();
    const started = runWithAttach(connection, openingCallsOf(connection), {}, DISPLAY);
    const run = await core.request("terminal.run");
    const early = await core.request("terminal.attach");
    core.reply(early.id, { error: notFound });
    core.reply(run.id, { result: { ...TERMINAL, address: "t3" } });
    const { address } = await started;
    const own = connection.attach({ terminal: address, cols: 90, rows: 20 });
    const second = await core.request("terminal.attach", 1);
    core.reply(second.id, { result: { channel: 4, terminal: { ...TERMINAL, address } } });
    const viewed = await viewAttach(connection, address, true, { cols: 90, rows: 20, display: DISPLAY }, () => own);
    expect([viewed.stream.channel, viewed.cols, viewed.rows]).toEqual([4, 90, 20]);
    expect(viewed.fresh).toBe(false);
    connection.close();
  });

  test("a run named by its caller, as a template's, goes alone: no attach can reach a live terminal of that name", async () => {
    const { connection, core } = await opened();
    const started = runWithAttach(
      connection,
      openingCallsOf(connection),
      { argv: ["claude"], name: "claude" },
      DISPLAY,
    );
    const run = await core.request("terminal.run");
    expect(run.params["name"]).toBe("claude");
    core.reply(run.id, { error: { code: -32000, message: "taken", data: { kind: "name_taken" } } });
    await expect(started).rejects.toMatchObject({ kind: "name_taken" });
    // A ping goes behind the run on the same wire: once it is in, anything sent with the run would be in too.
    void connection.call("terminal.list", {}).catch(() => undefined);
    await core.request("terminal.list");
    expect(core.requests.map((request) => request.method)).toEqual(["terminal.run", "terminal.list"]);
    connection.close();
  });

  test("any other refusal of that attach is the view's to show: it does not attach again", async () => {
    const { connection, core } = await opened();
    const started = runWithAttach(connection, openingCallsOf(connection), {}, DISPLAY);
    const run = await core.request("terminal.run");
    const early = await core.request("terminal.attach");
    core.reply(early.id, { error: { code: -32601, message: "no method", data: { kind: "unknown_method" } } });
    core.reply(run.id, { result: { ...TERMINAL, address: "t3" } });
    const { address } = await started;
    const viewing = viewAttach(connection, address, true, { cols: 90, rows: 20, display: DISPLAY }, attachedAgain);
    await expect(viewing).rejects.toMatchObject({ kind: "unknown_method" });
    connection.close();
  });
});

describe("a terminal opened from the list asks for its screen before its tab is written (#1351)", () => {
  test("the layout write waits until that attach is answered, so the attach never queues behind the core's disk write", async () => {
    const { connection, core } = await opened();
    attachAhead(connection, openingCallsOf(connection), "t4", DISPLAY);
    attachAhead(connection, openingCallsOf(connection), "t4", DISPLAY);
    const written = docCalls(connection, () => []).set(null, {}, 1);
    // A later call: requests arrive in order, so a layout write already sent would be on the wire ahead of it.
    const listed = connection.call("machine.list");
    const probe = await core.request("machine.list");
    expect(core.requests.map((request) => request.method)).toEqual(["terminal.attach", "machine.list"]);
    const attach = await core.request("terminal.attach");
    core.reply(attach.id, { result: { channel: 6, terminal: { ...TERMINAL, address: "t4" } } });
    const set = await core.request("doc.set");
    core.reply(set.id, { result: { version: 2 } });
    expect(await written).toEqual({ version: 2 });
    core.reply(probe.id, { result: { machines: [] } });
    await listed;
    const viewed = await viewAttach(connection, "t4", true, { cols: 100, rows: 30, display: DISPLAY }, attachedAgain);
    expect(viewed.stream.channel).toBe(6);
    // A terminal opened from the list has its history: its first paint is held as any other (#1928).
    expect(viewed.fresh).toBe(false);
    connection.close();
  });
});
