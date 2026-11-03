import { CloseCode } from "@doriface/crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcPipe } from "../hc-pipe.ts";
import { CLIENT, dial, gatewayOn, peerHello, PROBE, recordingPipe } from "../testing/gateway-harness.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { machine } from "../testing/mesh-history.ts";
import { hcLineOf } from "./hc-line.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let hc: HcSession;
const dirs: string[] = [];
beforeAll(() => {
  hc = createHcSession("first-line");
});
afterAll(async () => {
  await hc.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** hc 0.1.17's replies to `bytes` on a fresh connection, read until the reply to request `untilId`. */
async function hcReplies(bytes: string, untilId: number): Promise<readonly Record<string, unknown>[]> {
  const connection = hc.connect();
  await connection.write(encoder.encode(bytes));
  const read = async (replies: readonly Record<string, unknown>[]): Promise<readonly Record<string, unknown>[]> => {
    const reply: Record<string, unknown> = JSON.parse(decoder.decode(await connection.reader.line()));
    return reply["id"] === untilId ? [...replies, reply] : read([...replies, reply]);
  };
  const replies = await read([]);
  connection.end();
  return replies;
}
/** hc 0.1.17's one reply to `line` on a fresh connection. */
async function firstReply(line: string): Promise<Record<string, unknown>> {
  const connection = hc.connect();
  await connection.write(encoder.encode(`${line}\n`));
  const reply: Record<string, unknown> = JSON.parse(decoder.decode(await connection.reader.line()));
  connection.end();
  return reply;
}
const switched = (reply: Record<string, unknown> | undefined): boolean => {
  const result = reply?.["result"];
  return typeof result === "object" && result !== null && "framed" in result && result.framed === true;
};

const hello = (params: string) => `{"jsonrpc":"2.0","id":7,"method":"hello","params":${params}}`;
const LINES = [
  CLIENT.trimEnd(),
  peerHello("core-a").trimEnd(),
  PROBE.trimEnd().replace('"id":1', '"id":7'),
  '{"jsonrpc":"2.0","id":7,"method":"server.status"}',
  hello('{"framed":true,"generation":1.0}'),
  hello('{"framed":true,"generation":2}'),
  hello('{"framed":true,"calls_you":"\\ud800"}'),
  hello(`{"framed":true,"x":${"[".repeat(130)}${"]".repeat(130)}}`),
  hello('{"framed":true,"x":1e400}'),
  hello('{"framed":true,"features":null}'),
  hello('{"framed":true,"core":{"id":"x"}}'),
  hello('{"framed":true,"unknown":{"a":[1,2]}}'),
  hello('{"framed":true,"framed":false}'),
  hello('{"framed":false,"framed":true}'),
  hello("[null,true]"),
];

describe("HIGH-1 against a real hc 0.1.17", () => {
  test.each(LINES)("the gate reads %p as switching to frames exactly when hc does, or refuses it", async (line) => {
    const read = hcLineOf(encoder.encode(line));
    const reply = await firstReply(line);
    if (read.kind !== "malformed") expect(read.kind === "hello" && read.framed).toBe(switched(reply));
  });

  test("the lines hc refuses or reads otherwise are the ones the gate refuses", () => {
    expect(LINES.filter((line) => hcLineOf(encoder.encode(line)).kind === "malformed")).toHaveLength(8);
  });

  const AHEAD = ["\n", "[]\n", "not json\n", '{"jsonrpc":"2.0","id":0,"method":"ping"}\n'];
  const SHAPES = [...AHEAD, '{"jsonrpc":"2.0","id":0,"method":"hello","params":5}\n', '{"method":"hello"}\n'].map(
    (ahead) => ahead + peerHello("victim-core"),
  );
  SHAPES.push(peerHello("victim-core", "x".repeat(4300)));

  test.each(SHAPES.map((shape, i) => [i, shape] as const))(
    "review shape %i gets a member's claim read by hc itself",
    async (_, shape) => {
      const replies = await hcReplies(shape, 1);
      const last = replies.at(-1);
      expect(last?.["id"]).toBe(1);
      expect(switched(last)).toBe(true);
    },
  );

  test.each(SHAPES.map((shape, i) => [i, shape] as const))(
    "review shape %i through createGateway, a real Noise handshake and hc pipe: 4400, hc sent nothing",
    async (_, shape) => {
      const dir = mkdtempSync(join(tmpdir(), "dh-first-line-hc-"));
      dirs.push(dir);
      const [founder, member, phone] = [
        machine("founder"),
        { ...machine("member"), hcId: "victim-core" },
        machine("phone"),
      ];
      const pipe = recordingPipe(new HcPipe({ hc: hc.hc, session: hc.name, env: hc.env, log: () => {} }));
      const setup = gatewayOn(founder, member, { dir, openPipe: () => pipe.child });
      setup.devices.add(phone.identity.noise.publicKey, "phone");
      const run = await dial(setup, phone.identity.noise, founder);
      run.send(shape);
      await run.closed;
      expect(run.hostEnd.closeCode).toBe(CloseCode.CryptoFailure);
      expect(pipe.piped).toEqual([]);
      expect(run.received).toEqual([]);
    },
  );

  test("the control: a device's framed client hello reaches hc through the gateway, and hc answers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-first-line-hc-"));
    dirs.push(dir);
    const [founder, member, phone] = [machine("founder"), machine("member"), machine("phone")];
    const pipe = recordingPipe(new HcPipe({ hc: hc.hc, session: hc.name, env: hc.env, log: () => {} }));
    const setup = gatewayOn(founder, member, { dir, openPipe: () => pipe.child });
    setup.devices.add(phone.identity.noise.publicKey, "phone");
    const run = await dial(setup, phone.identity.noise, founder);
    run.send(CLIENT);
    await run.answered;
    expect(decoder.decode(Buffer.concat(run.received))).toContain('"framed":true');
    run.client.close();
  }, 30_000);
});
