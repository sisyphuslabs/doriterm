import { afterAll, expect, test } from "bun:test";
import { type ByteLink, HcConnection } from "@doriface/client";
import { END_LABEL, eventAddress } from "@doriface/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endSweeper } from "./end-sweeper.ts";
import { type HcTarget, spawnHcLink } from "./mesh/hc-machines.ts";
import { createHcSession, stopLeftoverCores } from "./testing/hc-session.ts";

const session = createHcSession("end-sweep");
const core = { hc: session.hc, session: session.name, env: session.env };
const scratch = mkdtempSync(join(tmpdir(), "end-sweep-"));

afterAll(async () => {
  await session.dispose();
  await stopLeftoverCores();
  rmSync(scratch, { recursive: true, force: true });
});

/** Records keys in order; `until` resolves once a key is recorded, before or after the call. */
function waiter() {
  const seen: string[] = [];
  const waiting = new Map<string, () => void>();
  return {
    seen,
    record: (key: string): void => {
      seen.push(key);
      waiting.get(key)?.();
    },
    until: (key: string): Promise<void> => {
      if (seen.includes(key)) return Promise.resolve();
      const done = Promise.withResolvers<void>();
      waiting.set(key, done.resolve);
      return done.promise;
    },
  };
}

/** A client of the core with every removal and finish it has seen, in order. */
async function observe() {
  const connection = await HcConnection.open(spawnHcLink(core));
  const events = waiter();
  const feed = await connection.subscribe();
  feed.onEvent((event) => {
    const address = eventAddress(event);
    if (address !== undefined && (event.type === "removed" || event.type === "finished"))
      events.record(`${event.type} ${address}`);
  });
  const run = async (argv: string[]): Promise<string> => (await connection.call("terminal.run", { argv })).address;
  const start = (): Promise<string> => run(["sh", "-c", "exec sleep 600"]);
  const mark = (address: string) =>
    connection.call("terminal.label", { terminal: address, labels: { [END_LABEL]: "1" } });
  const kill = (address: string) => connection.call("terminal.kill", { terminal: address });
  const removals = (): string[] =>
    events.seen.filter((key) => key.startsWith("removed ")).map((key) => key.slice("removed ".length));
  const listed = async (): Promise<string[]> =>
    (await connection.call("terminal.list", { all: true })).terminals.map((terminal) => terminal.address);
  return {
    connection,
    run,
    start,
    mark,
    kill,
    removals,
    listed,
    gone: (address: string) => events.until(`removed ${address}`),
    finished: (address: string) => events.until(`finished ${address}`),
  };
}

test("the host removes a killed terminal carrying the End label, whether marked before or after it finished", async () => {
  const client = await observe();
  const sweeper = endSweeper(core, () => {});
  try {
    // Finished and marked before the host watches: found when it starts.
    const early = await client.start();
    await client.kill(early);
    await client.mark(early);
    await sweeper.ensure();
    await client.gone(early);

    const unmarked = await client.start();
    const markedFirst = await client.start();
    const killedFirst = await client.start();
    await client.kill(unmarked);
    await client.mark(markedFirst);
    await client.kill(markedFirst);
    await client.kill(killedFirst);
    await client.mark(killedFirst);
    await client.gone(markedFirst);
    await client.gone(killedFirst);
    // The host acts on events in order, so it has seen `unmarked` finish and left it.
    // The host sends its removals in event order, but hc answers them concurrently: compare which, not in what order.
    expect(client.removals().toSorted()).toEqual([early, markedFirst, killedFirst].toSorted());
    expect(await client.listed()).toContain(unmarked);
  } finally {
    await sweeper.stop();
    client.connection.close();
  }
}, 30_000);

test("a marked terminal whose program exits by itself stays, with its output: its End never killed it", async () => {
  const client = await observe();
  const sweeper = endSweeper(core, () => {});
  const fifo = join(scratch, "exit-now");
  Bun.spawnSync(["mkfifo", fifo]);
  try {
    // One exits before the host watches (found by its start-up list), one while it watches (seen as an event).
    const exitedBefore = await client.run(["sh", "-c", "echo kept-before; exit 4"]);
    await client.mark(exitedBefore);
    await client.finished(exitedBefore);
    await sweeper.ensure();
    const exiting = await client.run(["sh", "-c", `echo kept-output; read line < ${fifo}; exit 3`]);
    await client.mark(exiting);
    writeFileSync(fifo, "go\n");
    await client.finished(exiting);
    // A killed, marked terminal after it: once the host has removed that one, it has seen `exiting` finish.
    const killed = await client.start();
    await client.mark(killed);
    await client.kill(killed);
    await client.gone(killed);
    const read = async (address: string) => {
      const shown = await client.connection.call("terminal.get", { terminal: address });
      const text = (await client.connection.call("terminal.read", { terminal: address })).text;
      return [shown.state, shown.reason, text.includes(address === exiting ? "kept-output" : "kept-before")];
    };
    expect(await Promise.all([read(exitedBefore), read(exiting)])).toEqual([
      ["finished", "exited", true],
      ["finished", "exited", true],
    ]);
  } finally {
    await sweeper.stop();
    client.connection.close();
  }
}, 30_000);

/** `hc connect` children the sweeper opens; with `holdExits`, each exit notice waits for `release`. */
function childLinks(holdExits: boolean) {
  const links: ByteLink[] = [];
  const held: (() => void)[] = [];
  const open = (target: HcTarget): ByteLink => {
    const child = spawnHcLink(target);
    const link: ByteLink = {
      send: (bytes) => child.send(bytes),
      onData: (listener) => child.onData(listener),
      onClose: (listener) => child.onClose((error) => (holdExits ? held.push(() => listener(error)) : listener(error))),
      close: () => child.close(),
    };
    links.push(child);
    return link;
  };
  const child = (index: number): ByteLink => {
    const found = links[index];
    if (found === undefined) throw new Error(`no child ${index}`);
    return found;
  };
  return {
    open,
    exited: (index: number): Promise<void> => new Promise((resolve) => child(index).onClose(() => resolve())),
    close: (index: number): void => child(index).close(),
    release: () => {
      for (const deliver of held.splice(0)) deliver();
    },
  };
}

test("stop returns only once the watcher's hc connect child has exited", async () => {
  const children = childLinks(true);
  const sweeper = endSweeper(core, () => {}, children.open);
  await sweeper.ensure();
  let stopped = false;
  const stopping = (async () => {
    await sweeper.stop();
    stopped = true;
  })();
  await children.exited(0);
  // The child has exited, but its exit notice is held: stop must still be waiting for it.
  expect(stopped).toBe(false);
  children.release();
  await stopping;
  expect(stopped).toBe(true);
}, 30_000);

test("a watcher whose connection closed watches again on the next ensure", async () => {
  const children = childLinks(false);
  const sweeper = endSweeper(core, () => {}, children.open);
  try {
    await sweeper.ensure();
    // The watcher's hc connect child goes away (as when the core restarts), and its connection closes.
    const gone = children.exited(0);
    children.close(0);
    await gone;
    const client = await observe();
    const terminal = await client.start();
    await client.mark(terminal);
    await sweeper.ensure();
    await client.kill(terminal);
    await client.gone(terminal);
    client.connection.close();
  } finally {
    await sweeper.stop();
  }
}, 30_000);
