import { expect, test } from "bun:test";
import { terminalUri } from "./subscriptions.ts";
import { session } from "./subscriptions.test-support.ts";

test("discover advertises resources and the events extension, and events/list names the one event type", async () => {
  const s = session();
  s.request(1, "server/discover");
  s.request(2, "events/list");
  expect(s.sent[0]).toMatchObject({
    result: {
      capabilities: { resources: { listChanged: true }, extensions: { "io.modelcontextprotocol/events": {} } },
    },
  });
  expect(s.sent[1]).toMatchObject({ result: { events: [{ name: "terminal.changed", delivery: ["push"] }] } });
});

test("terminals are resources: listed by address and read as their screen text; another URI is not found", async () => {
  const s = session();
  const answered = s.next(2);
  s.request(1, "resources/list");
  s.request(2, "resources/read", { uri: terminalUri("box/t7") });
  s.request(3, "resources/read", { uri: "file:///etc/passwd" });
  await answered;
  const byId = (id: number) => s.sent.find((message) => message["id"] === id);
  expect(byId(1)).toMatchObject({
    result: {
      resources: [
        { uri: "doriterm://terminal/t1", name: "build" },
        { uri: "doriterm://terminal/box%2Ft7", name: "box/t7" },
      ],
    },
  });
  expect(byId(2)).toMatchObject({ result: { contents: [{ uri: "doriterm://terminal/box%2Ft7", text: "$ ok" }] } });
  expect(byId(3)).toMatchObject({ error: { code: -32602, message: "Resource not found" } });
});
