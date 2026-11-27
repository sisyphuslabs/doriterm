import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSwitch } from "../../apps/host/src/state/mcp-switch.ts";
import { HELLO } from "../../apps/host/src/testing/hc-session.ts";
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
/** As in connect.test.ts: a refusal ends the process before connect's own dial deadline (#468). */
const REFUSAL_MS = DIAL_TIMEOUT_MS;
const scratch = mkdtempSync(join(tmpdir(), "connect-mcp-"));
let relayed: RelayedHost | undefined;

function host(): RelayedHost {
  if (relayed === undefined) throw new Error("setup failed");
  return relayed;
}

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-connect-mcp");
}, 120_000);

afterAll(async () => {
  await relayed?.stop();
  rmSync(scratch, { recursive: true, force: true });
}, RELAYED_STOP_MS);

describe("doriface-host connect --mcp: the Model Context Protocol to a paired host through the relay", () => {
  test("--mcp is refused while MCP is off (the default), carries MCP over the relay once it is on, and switching it off ends the session", async () => {
    const { relayUrl, hostId, stateDir } = host();
    const state = join(scratch, "mcp-device");
    const pairing = runConnect(state, relayUrl, await host().pairingLink(), "--name", "assistant");
    await pairing.write(HELLO);
    await within(pairing.reader.line(), "hello over the pairing run");
    pairing.end();
    expect(await within(pairing.exited, "the pairing run exiting")).toBe(0);

    // Paired, but MCP is off on the host (the default): the refusal says so instead of asking to pair again.
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
