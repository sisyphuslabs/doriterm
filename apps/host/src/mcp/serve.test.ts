import { CloseCode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { expect, test } from "bun:test";
import { serveMcpLines } from "./serve.ts";
import { SERVER_INSTRUCTIONS } from "./lines.ts";

const VERSION = "2026-07-28";
const LIMIT = 256 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const encode = (object: object): Uint8Array => enc.encode(`${JSON.stringify(object)}\n`);
const request = (id: number | undefined, method = "server/discover", version: unknown = VERSION) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: { _meta: { "io.modelcontextprotocol/protocolVersion": version } },
});
const discover = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: {
    resultType: "complete",
    supportedVersions: [VERSION],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "doriterm", version: "1.2.3" } },
    instructions: SERVER_INSTRUCTIONS,
  },
});

function open() {
  const [client, server] = memoryLinkPair(true);
  serveMcpLines(server, { hostVersion: "1.2.3" });
  const answers = (): unknown[] => server.sent.map((bytes) => JSON.parse(dec.decode(bytes)));
  return { client, server, answers };
}

test("server/discover advertises only the supported revision and host version", () => {
  const { client, server, answers } = open();
  client.send(encode(request(1)));
  expect(answers()).toEqual([discover(1)]);
  expect(server.sent[0]?.at(-1)).toBe(10);
});

test("server/discover carries instructions a client can show the model, within what clients keep", () => {
  expect(typeof SERVER_INSTRUCTIONS).toBe("string");
  expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
  // Claude Code cuts server instructions at 2,048 characters.
  expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  expect(SERVER_INSTRUCTIONS).toContain("doriterm_tools");
});

test.each([
  { input: "old", requested: "old" },
  { input: null, requested: null },
  { input: 2026, requested: null },
  { input: { version: VERSION }, requested: null },
  { input: [VERSION], requested: null },
])("rejects a mismatched protocol version and never echoes a non-string: $input", ({ input, requested }) => {
  const { client, answers } = open();
  client.send(encode(request(1, "server/discover", input)));
  expect(answers()).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32022, message: "Unsupported protocol version", data: { supported: [VERSION], requested } },
    },
  ]);
});

test("a request without a protocol version gets -32022 and requested null", () => {
  const { client, answers } = open();
  client.send(encode({ jsonrpc: "2.0", id: 1, method: "server/discover" }));
  expect(answers()).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32022, message: "Unsupported protocol version", data: { supported: [VERSION], requested: null } },
    },
  ]);
});

test("a method this host does not serve gets Method not found", () => {
  const { client, answers } = open();
  client.send(encode(request(12, "resources/list")));
  expect(answers()).toEqual([{ jsonrpc: "2.0", id: 12, error: { code: -32601, message: "Method not found" } }]);
});

test("a notification is consumed without a response", () => {
  const { client, answers } = open();
  client.send(encode(request(undefined)));
  client.send(encode(request(1)));
  expect(answers()).toEqual([discover(1)]);
});

test("an object that is neither request nor notification receives Invalid Request", () => {
  const { client, answers } = open();
  client.send(encode({ jsonrpc: "2.0", id: 2, result: {} }));
  expect(answers()).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }]);
});

test.each([
  { name: "a line one byte over the LF-inclusive limit", bytes: enc.encode(`${" ".repeat(LIMIT)}\n`) },
  { name: "malformed UTF-8 inside otherwise valid JSON", bytes: new Uint8Array([123, 34, 0xff, 34, 58, 48, 125, 10]) },
  { name: "a JSON array", bytes: encode([]) },
])("closes with 4400 on $name and drops later lines", ({ bytes }) => {
  const { client, server, answers } = open();
  client.send(Buffer.concat([bytes, encode(request(1))]));
  expect(server.closeCode).toBe(CloseCode.CryptoFailure);
  expect(answers()).toEqual([]);
});

test("a line of exactly 256 KiB including LF is accepted", () => {
  const { client, answers } = open();
  const line = encode(request(1));
  client.send(Buffer.concat([Buffer.alloc(LIMIT - line.length, 0x20), line]));
  expect(answers()).toEqual([discover(1)]);
});

test("complete and split requests in consecutive chunks are answered in order", () => {
  const { client, answers } = open();
  const third = encode({ ...request(3), id: "é" });
  const split = third.indexOf(0xc3) + 1;
  client.send(Buffer.concat([encode(request(1)), encode(request(2)), third.subarray(0, split)]));
  expect(answers()).toEqual([discover(1), discover(2)]);
  client.send(third.subarray(split));
  expect(answers()).toEqual([discover(1), discover(2), { ...discover(3), id: "é" }]);
});
