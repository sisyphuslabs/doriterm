import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fingerprintOf, generateHostIdentity, generateX25519 } from "@doriface/crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnownHosts } from "../../apps/host/src/state/known-hosts.ts";
import { McpSwitch } from "../../apps/host/src/state/mcp-switch.ts";
import { HELLO, rpcFrame } from "../../apps/host/src/testing/hc-session.ts";
import { DIAL_TIMEOUT_MS } from "../../apps/host/src/commands/connect.ts";
import { runConnect } from "./support/connect-cli.ts";
import { type RelayedHost, startRelayedHost, RELAYED_STOP_MS } from "./support/relayed-host.ts";
import { within } from "./support/watch.ts";
import { setUpOnce } from "./support/set-up-once.ts";

const decoder = new TextDecoder();
const mcpLine = (id: number, method: string, params: object = {}): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }, ...params } })}\n`,
  );
/**
 * A refusal must end the process before connect's own dial deadline would (`DIAL_TIMEOUT_MS`, inside hc's 20 s), so the
 * reason on stderr is the refusal's, which each case checks. The refusal itself is cheap: from spawn to exit, 60 refusals
 * at load 93-109 took p50 0.43 s and at most 1.47 s, of which starting the CLI was up to 0.46 s; under load ~150 a start
 * alone crossed the 5 s this used to be (#468).
 */
const REFUSAL_MS = DIAL_TIMEOUT_MS;
const phone = generateX25519();
const scratch = mkdtempSync(join(tmpdir(), "connect-"));
const deviceState = join(scratch, "device");
let relayed: RelayedHost | undefined;

function host(): RelayedHost {
  if (relayed === undefined) throw new Error("setup failed");
  return relayed;
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-connect");
  await relayed.pair(phone, "phone");
}, 120_000);

afterAll(async () => {
  await relayed?.stop();
  rmSync(scratch, { recursive: true, force: true });
}, RELAYED_STOP_MS);

describe("doriface-host connect: stdin and stdout piped to the host's hc connect through the relay", () => {
  test("a pairing link pairs once, then the hostId alone reaches hc, byte for byte like a direct hc connect", async () => {
    const { relayUrl, hostId, session } = host();
    const link = await host().pairingLink();
    const pairing = runConnect(deviceState, relayUrl, link, "--name", "device", "sh -c 'exec herdr-core connect'");
    await pairing.write(HELLO);
    const pairedHello = await within(pairing.reader.line(), "hello over the pairing run");
    pairing.end();
    expect(await within(pairing.exited, "the pairing run exiting")).toBe(0);
    expect(await pairing.stderr()).toContain(`doriface-host connect ${hostId}`);
    expect(JSON.parse(decoder.decode(pairedHello)).result.framed).toBe(true);

    const run = runConnect(deviceState, relayUrl, hostId);
    await run.write(HELLO);
    const hello = await within(run.reader.line(), "hello");
    await run.write(rpcFrame(1, "terminal.list"));
    const list = await within(run.reader.frame(), "terminal.list");
    run.end();
    expect(await within(run.exited, "exit after stdin ends")).toBe(0);

    const direct = session.connect();
    await direct.write(HELLO);
    const helloDirect = await direct.reader.line();
    await direct.write(rpcFrame(1, "terminal.list"));
    const listDirect = await direct.reader.frame();
    direct.end();
    await direct.exited;
    expect(hello).toEqual(helloDirect);
    expect(list).toEqual(listDirect);
  }, 60_000);

  test("SIGTERM ends a live pipe with exit 0", async () => {
    const run = runConnect(deviceState, host().relayUrl, host().hostId);
    await run.write(HELLO);
    await within(run.reader.line(), "hello");
    run.kill("SIGTERM");
    expect(await within(run.exited, "exit after SIGTERM")).toBe(0);
  }, 30_000);

  test("a typed code pairs with CPace through the relay once the host's fingerprint is confirmed", async () => {
    const code = await host().pairingCode();
    const other = join(scratch, "other");
    const fingerprint = fingerprintOf(host().hostKey).split(" ").slice(0, 4).join(" ");
    const run = runConnect(other, host().relayUrl, code, "--name", "typed", "--fingerprint", fingerprint);
    await run.write(HELLO);
    expect(JSON.parse(decoder.decode(await within(run.reader.line(), "hello"))).result.framed).toBe(true);
    run.end();
    expect(await within(run.exited, "exit")).toBe(0);
  }, 60_000);

  test.each([
    ["no fingerprint", [], "--fingerprint"],
    ["a fingerprint that does not match", ["--fingerprint", "0000 0000 0000 0000"], "does not match"],
    ["too short a fingerprint", ["--fingerprint", "3FA9"], "at least the first 4 groups"],
  ])(
    "a typed code with %s is refused before any pairing",
    async (_case, extra, says) => {
      const before = host().logs.filter((line) => line.startsWith("paired device")).length;
      const run = runConnect(join(scratch, "unconfirmed"), host().relayUrl, await host().pairingCode(), ...extra);
      expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
      expect((await run.stderr()).trim().split("\n").at(-1)).toContain(says);
      expect(host().logs.filter((line) => line.startsWith("paired device")).length).toBe(before);
    },
    30_000,
  );

  test("the shell line hc appends to a --via command is taken and ignored", async () => {
    const line =
      "sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; HC_SESSION=other exec \"$p\" connect'";
    const run = runConnect(deviceState, host().relayUrl, host().hostId, line);
    await run.write(HELLO);
    const own = await host().connect(phone);
    own.close();
    expect(JSON.parse(decoder.decode(await within(run.reader.line(), "hello"))).result.core.id).toBe(own.hello.core.id);
    run.end();
    expect(await within(run.exited, "exit")).toBe(0);
  }, 30_000);

  test("a paired host that is not on the relay (4404) fails within a few seconds, exit 1", async () => {
    const offline = join(scratch, "offline");
    const absent = generateHostIdentity();
    new KnownHosts(offline).add({ hostId: absent.hostId, hostKey: absent.noise.publicKey, relayUrl: host().relayUrl });
    const run = runConnect(offline, host().relayUrl, absent.hostId);
    expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
    expect((await run.stderr()).trim().split("\n").at(-1)).toMatch(/is not connected to the relay: .*\(4404\)$/);
  }, 30_000);

  test("a typed code no host is pairing with (the relay's lookup answers 404) fails within a few seconds, exit 1", async () => {
    const run = runConnect(join(scratch, "nocode"), host().relayUrl, "ZZZZ-ZZZZ");
    expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
    expect((await run.stderr()).trim().split("\n").at(-1)).toContain("no host is pairing with this code");
  }, 30_000);

  test.each([
    ["key", true],
    ["relay", false],
  ])(
    "a fresh link whose %s differs from the saved one is refused without --replace, writes nothing, and still pairs",
    async (what, newKey) => {
      const changed = join(scratch, `changed-${what}`);
      const oldKey = newKey ? generateX25519().publicKey : host().hostKey;
      const oldRelay = newKey ? host().relayUrl : "https://old-relay.example";
      new KnownHosts(changed).add({ hostId: host().hostId, hostKey: oldKey, relayUrl: oldRelay });
      const saved = readFileSync(join(changed, "known-hosts.json"));
      const paired = host().logs.filter((line) => line.startsWith("paired device")).length;
      const link = await host().pairingLink();
      const run = runConnect(changed, host().relayUrl, link, "--name", "changed");
      expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
      const stderr = await run.stderr();
      const notice = newKey
        ? `host key changed for ${host().hostId}: old fingerprint ${fingerprintOf(oldKey)} -> new ${fingerprintOf(host().hostKey)}`
        : `relay changed for ${host().hostId}: ${oldRelay} -> ${host().relayUrl}`;
      expect(stderr).toContain(notice);
      expect(stderr.trim().split("\n").at(-1)).toContain("--replace");
      expect(readFileSync(join(changed, "known-hosts.json"))).toEqual(saved);
      expect(host().logs.filter((line) => line.startsWith("paired device")).length).toBe(paired);

      // The refusal spent nothing: the same single-use link pairs once --replace allows the change.
      const again = runConnect(changed, host().relayUrl, link, "--name", "changed", "--replace");
      await again.write(HELLO);
      expect(
        JSON.parse(decoder.decode(await within(again.reader.line(), "hello on the same link"))).result.framed,
      ).toBe(true);
      again.end();
      expect(await within(again.exited, "exit")).toBe(0);
      expect(new KnownHosts(changed).get(host().hostId)?.hostKey).toEqual(host().hostKey);
    },
    30_000,
  );

  test("with --replace, a changed host key is replaced after the notice, and hello answers", async () => {
    const replaced = join(scratch, "replaced");
    const oldKey = generateX25519().publicKey;
    new KnownHosts(replaced).add({ hostId: host().hostId, hostKey: oldKey, relayUrl: host().relayUrl });
    const run = runConnect(replaced, host().relayUrl, await host().pairingLink(), "--name", "replaced", "--replace");
    await run.write(HELLO);
    expect(JSON.parse(decoder.decode(await within(run.reader.line(), "hello"))).result.framed).toBe(true);
    run.end();
    expect(await within(run.exited, "exit")).toBe(0);
    expect(await run.stderr()).toContain(`host key changed for ${host().hostId}`);
    expect(new KnownHosts(replaced).get(host().hostId)?.hostKey).toEqual(host().hostKey);
  }, 30_000);

  test("a pinned key that is not the live host's is refused with 4400 before any byte reaches hc", async () => {
    const wrongKey = join(scratch, "wrong-key");
    new KnownHosts(wrongKey).add({
      hostId: host().hostId,
      hostKey: generateX25519().publicKey,
      relayUrl: host().relayUrl,
    });
    const run = runConnect(wrongKey, host().relayUrl, host().hostId);
    await run.write(HELLO);
    expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
    expect((await run.stderr()).trim().split("\n").at(-1)).toMatch(/its key may not match .*\(4400\)$/);
    const leftover = await run.reader.line().then(
      () => "a line",
      (error: unknown) => String(error),
    );
    expect(leftover).toContain("stream ended with 0 unparsed bytes");
  }, 30_000);

  test("a host this machine never paired fails fast with one clear last line and exit 1", async () => {
    const run = runConnect(join(scratch, "stranger"), host().relayUrl, host().hostId);
    expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
    const lines = (await run.stderr()).trim().split("\n");
    expect(lines.at(-1)).toContain("has not paired with host");
  }, 30_000);

  test("after a revoke, a fresh pairing link pairs again and hello answers", async () => {
    const again = join(scratch, "again");
    const first = runConnect(again, host().relayUrl, await host().pairingLink(), "--name", "again");
    first.end();
    expect(await within(first.exited, "the first pairing")).toBe(0);
    await host().revokeAll();
    const repair = runConnect(again, host().relayUrl, await host().pairingLink(), "--name", "again");
    await repair.write(HELLO);
    expect(JSON.parse(decoder.decode(await within(repair.reader.line(), "hello after re-pairing"))).result.framed).toBe(
      true,
    );
    repair.end();
    expect(await within(repair.exited, "exit")).toBe(0);
    const plain = runConnect(again, host().relayUrl, host().hostId);
    await plain.write(HELLO);
    expect(JSON.parse(decoder.decode(await within(plain.reader.line(), "hello by hostId"))).result.framed).toBe(true);
    plain.end();
    expect(await within(plain.exited, "exit")).toBe(0);
  }, 60_000);

  test("a device the host revoked or never stored is told to pair again", async () => {
    const stranger = join(scratch, "forgotten");
    const pair = runConnect(stranger, host().relayUrl, await host().pairingLink(), "--name", "forgotten");
    pair.end();
    expect(await within(pair.exited, "pairing")).toBe(0);
    await host().revokeAll();
    const run = runConnect(stranger, host().relayUrl, host().hostId);
    expect(await within(run.exited, "the refusal", REFUSAL_MS)).toBe(1);
    expect((await run.stderr()).trim().split("\n").at(-1)).toContain("pair it again (4401)");
  }, 60_000);

  test("--mcp carries MCP over the relay once the host has it switched on, and switching it off ends the session", async () => {
    const { relayUrl, hostId, stateDir } = host();
    const state = join(scratch, "mcp-device");
    const pairing = runConnect(state, relayUrl, await host().pairingLink(), "--name", "assistant");
    await pairing.write(HELLO);
    await within(pairing.reader.line(), "hello over the pairing run");
    pairing.end();
    expect(await within(pairing.exited, "the pairing run exiting")).toBe(0);

    // Paired, but MCP is off on the host: the refusal says so instead of asking to pair again.
    const refused = runConnect(state, relayUrl, hostId, "--mcp");
    expect(await within(refused.exited, "the refusal", REFUSAL_MS)).toBe(1);
    expect(await refused.stderr()).toContain("run doriface-host mcp on there");

    new McpSwitch(stateDir).setEnabled(true);
    const run = runConnect(state, relayUrl, hostId, "--mcp", "--tools", "machine");
    await run.write(mcpLine(1, "server/discover"));
    const discovered = JSON.parse(decoder.decode(await within(run.reader.line(), "the discover answer")));
    expect(discovered.result.capabilities).toEqual({
      tools: {},
      resources: { listChanged: true },
      extensions: { "io.modelcontextprotocol/events": {} },
    });
    await run.write(mcpLine(2, "tools/call", { name: "terminal_list", arguments: {} }));
    const listed = JSON.parse(decoder.decode(await within(run.reader.line(), "the terminal_list answer")));
    expect(listed.result.isError).toBe(false);
    expect(Array.isArray(listed.result.structuredContent.terminals)).toBe(true);

    // --tools reached the host before the first line from stdin: the list is the core two and the group asked for.
    await run.write(mcpLine(3, "tools/list"));
    const shown = JSON.parse(decoder.decode(await within(run.reader.line(), "the tools/list answer")));
    const names: string[] = shown.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.slice(0, 2)).toEqual(["doriterm_tools", "doriterm_call"]);
    expect(names.length).toBeGreaterThan(2);
    expect(names.slice(2).every((name) => name.startsWith("machine_"))).toBe(true);
    await run.write(mcpLine(4, "tools/call", { name: "doriterm_call", arguments: { tool: "terminal_list" } }));
    const through = JSON.parse(decoder.decode(await within(run.reader.line(), "the doriterm_call answer")));
    expect(Array.isArray(through.result.structuredContent.terminals)).toBe(true);

    // A mesh tool answers from the running host itself: this very device is in its list, under the name it paired as.
    await run.write(mcpLine(5, "tools/call", { name: "mesh_status", arguments: {} }));
    const mesh = JSON.parse(decoder.decode(await within(run.reader.line(), "the mesh_status answer")));
    expect(mesh.result.isError).toBe(false);
    expect(mesh.result.structuredContent.devices.map((device: { name: string }) => device.name)).toContain("assistant");
    expect(mesh.result.structuredContent.joins).toEqual([]);

    // A real terminal finishing reaches the client as an MCP event, on a stream narrowed to its label.
    await run.write(
      mcpLine(6, "events/stream", { name: "terminal.changed", arguments: { labels: { mcp: "relay-test" } } }),
    );
    const active = JSON.parse(decoder.decode(await within(run.reader.line(), "the events/stream confirmation")));
    expect(active.method).toBe("notifications/events/active");
    await run.write(
      mcpLine(7, "tools/call", {
        name: "doriterm_call",
        arguments: { tool: "terminal_run", arguments: { argv: ["true"], labels: { mcp: "relay-test" } } },
      }),
    );
    // Lines arrive in order: the tool's reply and the terminal's earlier events come first, so read until it finishes.
    type Finished = { params: { data: { type: string; terminal: string } } };
    const nextFinished = async (): Promise<Finished> => {
      const message = JSON.parse(decoder.decode(await within(run.reader.line(), "the terminal's finished event")));
      const isFinished = message.method === "notifications/events/event" && message.params.data.type === "finished";
      return isFinished ? message : nextFinished();
    };
    expect((await nextFinished()).params.data.terminal).toMatch(/^t\d+$/);

    new McpSwitch(stateDir).setEnabled(false);
    expect(await within(run.exited, "the session ending once MCP is off")).toBe(1);
  });
});
