import { expect, test } from "bun:test";
import { HcConnection } from "./connection.ts";
import { HcConnectionClosedError } from "./errors.ts";
import { FakeCore } from "./testing/fake-core.ts";
import { HELLO_REPLY_LINE, RUN_REPLY, withId } from "./testing/fixtures.ts";

async function opened(core: FakeCore): Promise<HcConnection> {
  const connection = HcConnection.open(core.client);
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  return connection;
}

// A terminal Doriterm starts is released, never ended, when the terminal that started it ends (#2990).
test.each([
  ["call", (connection: HcConnection) => connection.call("terminal.run", { argv: ["sh"], parent: "t1" })],
  [
    "callByName (the MCP server's run)",
    (connection: HcConnection) => connection.callByName("terminal.run", { argv: ["sh"], parent: "t1" }),
  ],
  [
    "call that asked to end with its parent",
    (connection: HcConnection) => connection.call("terminal.run", { parent: "t1", outlive_parent: false }),
  ],
] as const)("a terminal.run sent through %s outlives its parent", async (_, run) => {
  const core = new FakeCore();
  const connection = await opened(core);
  const started = run(connection);
  const request = await core.waitRequest("terminal.run");
  expect(request.params).toMatchObject({ parent: "t1", outlive_parent: true });
  core.pushFrame(0, 0, withId(RUN_REPLY, Number(request.id)));
  await started;
  connection.close();
});

test("a call other than terminal.run goes out with its params as given", async () => {
  const core = new FakeCore();
  const connection = await opened(core);
  const got = connection.call("terminal.get", { terminal: "t1" });
  const request = await core.waitRequest("terminal.get");
  expect(request.params).toEqual({ terminal: "t1" });
  connection.close();
  await expect(got).rejects.toBeInstanceOf(HcConnectionClosedError);
});
