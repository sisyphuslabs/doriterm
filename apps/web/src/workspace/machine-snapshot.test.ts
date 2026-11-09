import { HcConnection } from "@doriface/client";
import { parseJsonRpc, type MachineView } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { FakeCore } from "../../../../packages/client/src/testing/fake-core.ts";
import { HELLO_REPLY_LINE } from "../../../../packages/client/src/testing/fixtures.ts";
import { machineSnapshots } from "./machine-snapshot.ts";
import { machineEntries } from "./machines.ts";
import { startTerminal } from "./start-on.ts";

const machine = (state: string): MachineView => ({
  id: "rack-core",
  name: "rack",
  host: "rack",
  target: "rack",
  version: "0.1.17",
  state,
  since_ms: Date.now(),
});

async function opened() {
  const core = new FakeCore();
  const opening = HcConnection.open(core.client);
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  return { core, connection: await opening };
}

async function listed(core: FakeCore, connection: HcConnection, state: string): Promise<void> {
  const from = core.frames.length;
  const reading = machineSnapshots(connection).refresh();
  const request = await nextRequest(core, from);
  core.pushFrame(0, 0, JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { machines: [machine(state)] } }));
  await reading;
}

async function nextRequest(core: FakeCore, from: number) {
  const frame = await core.waitFrame((item) => item.channel === 0 && item.kind === 0, from);
  const request = parseJsonRpc(new TextDecoder().decode(frame.payload));
  if (request.kind !== "request") throw new Error("expected the next RPC request");
  return request;
}

test("Spaces, Machines and creation share a dropped machine's state, then recover together", async () => {
  const { core, connection } = await opened();
  try {
    const spaces = machineSnapshots(connection);
    const settings = machineSnapshots(connection);
    await listed(core, connection, "connected");
    await listed(core, connection, "unreachable");

    const entries = machineEntries(connection.hello.core, spaces.getSnapshot().views, []);
    expect(entries.find((entry) => entry.name === "rack")?.state).toBe("reconnecting");
    expect(settings.getSnapshot().views[0]?.state).toBe("reconnecting");
    let runs = 0;
    const refused = await startTerminal(
      () => {
        runs += 1;
        return Promise.resolve({ address: "rack/t1" });
      },
      { on: "rack" },
      connection.hello.core.name,
      spaces.getSnapshot().views[0],
    );
    expect(runs).toBe(0);
    expect(refused).toEqual({
      ok: false,
      failure: { machine: "rack", kind: "unavailable", message: "rack is reconnecting; try again once it is back." },
    });

    await listed(core, connection, "connected");
    const starting = startTerminal(
      (params) => connection.call("terminal.run", params),
      { on: "rack" },
      connection.hello.core.name,
      spaces.getSnapshot().views[0],
    );
    const request = await core.waitRequest("terminal.run");
    core.pushFrame(0, 0, JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { address: "rack/t1" } }));
    expect(await starting).toEqual({ ok: true, address: "rack/t1" });
    expect(settings.getSnapshot().views[0]?.state).toBe("connected");
  } finally {
    connection.close();
  }
});

test("a create refusal updates every reader and a list sent before the refusal cannot restore connected", async () => {
  const { core, connection } = await opened();
  try {
    await listed(core, connection, "connected");
    const store = machineSnapshots(connection);
    const from = core.frames.length;
    const reading = store.refresh();
    const request = await nextRequest(core, from);

    store.unavailable("rack");
    expect(machineSnapshots(connection).getSnapshot().views[0]?.state).toBe("reconnecting");
    core.pushFrame(
      0,
      0,
      JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { machines: [machine("connected")] } }),
    );
    await reading;
    expect(store.getSnapshot().views[0]?.state).toBe("reconnecting");
  } finally {
    connection.close();
  }
});
