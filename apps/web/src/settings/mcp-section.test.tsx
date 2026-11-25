import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopMcp, mcpAnswer } from "../desktop/mcp-bridge.ts";
import { McpClients, McpSection } from "./mcp-section.tsx";
import { connectCommand, mcpConfig, mcpView, turnOffLine } from "./mcp-view.ts";

const acts = { busy: false, note: null, onSwitch: () => {}, onConnect: () => {}, onDisconnect: () => {} };

test("an answer from the shell is read only in the one shape, and anything else is no answer", () => {
  const clients = [
    { id: "3FA94C0E", name: "Grok bot" },
    { id: "AB12CD34", name: null },
  ];
  expect(mcpAnswer({ state: "read", enabled: true, clients, extra: 1 })).toEqual({
    state: "read",
    enabled: true,
    clients,
  });
  expect(mcpAnswer({ state: "unavailable", reason: "no host" })).toEqual({ state: "unavailable", reason: "no host" });
  for (const bad of [
    null,
    {},
    { state: "read", enabled: "true", clients: [] },
    { state: "read", enabled: true },
    { state: "read", enabled: true, clients: [{ id: 7, name: "x" }] },
    { state: "read", enabled: true, clients: [{ id: "A", name: 3 }] },
    { state: "unavailable" },
  ]) {
    expect(mcpAnswer(bad)).toBeUndefined();
  }
});

test("a shell without the call gives no bridge, and the section draws nothing in a browser", () => {
  expect(desktopMcp({})).toBeNull();
  expect(desktopMcp({ doriface: {} })).toBeNull();
  expect(renderToStaticMarkup(<McpSection />)).toBe("");
});

test("a shell answer in the wrong shape is an error to the page, never a state", async () => {
  const mcp = desktopMcp({ doriface: { mcp: async () => ({ state: "read", enabled: 1, clients: [] }) } });
  expect(mcp).not.toBeNull();
  expect(mcp?.("state")).rejects.toThrow("no MCP state");
});

test("off shows the switch alone; on with nothing connected says so and offers to connect", () => {
  const off = renderToStaticMarkup(
    <McpClients view={mcpView({ state: "read", enabled: false, clients: [] })} {...acts} />,
  );
  expect(off).toContain("MCP clients");
  expect(off).not.toContain("Connect an MCP client");
  expect(off).not.toContain("Connected clients");
  const empty = renderToStaticMarkup(
    <McpClients view={mcpView({ state: "read", enabled: true, clients: [] })} {...acts} />,
  );
  expect(empty).toContain("No MCP client is connected to this computer.");
  expect(empty).toContain("Connect an MCP client");
});

test("each connected client has its own Disconnect, and a mesh client is named as one", () => {
  const view = mcpView({
    state: "read",
    enabled: true,
    clients: [
      { id: "3FA94C0E", name: "Grok bot" },
      { id: "AB12CD34", name: null },
    ],
  });
  const html = renderToStaticMarkup(<McpClients view={view} {...acts} />);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-label="Disconnect Grok bot"');
  expect(html).toContain('aria-label="Disconnect A mesh client"');
  expect(html).toContain("3FA94C0E");
  expect(html).toContain("Connected clients");
});

test("a host that cannot answer disables the switch and says why; a shell without pairing offers no connect", () => {
  const html = renderToStaticMarkup(
    <McpClients
      view={mcpView({ state: "unavailable", reason: "This doriface-host is too old to accept MCP clients." })}
      {...acts}
    />,
  );
  expect(html).toContain("This doriface-host is too old to accept MCP clients.");
  expect(html).toContain("disabled");
  expect(renderToStaticMarkup(<McpClients view={mcpView(null)} {...acts} />)).toContain("Asking this computer");
  const noPair = renderToStaticMarkup(
    <McpClients view={mcpView({ state: "read", enabled: true, clients: [] })} {...acts} onConnect={null} />,
  );
  expect(noPair).not.toContain("Connect an MCP client");
});

test("the config names this host for connect --mcp, and the pairing command quotes the link", () => {
  expect(JSON.parse(mcpConfig("5k2nq7ra"))).toEqual({
    mcpServers: { doriterm: { command: "doriface-host", args: ["connect", "--mcp", "5k2nq7ra"] } },
  });
  expect(connectCommand("doriface://pair#p=abc")).toBe("doriface-host connect 'doriface://pair#p=abc'");
  expect(turnOffLine(1)).toBe("1 session closes. Paired devices stay paired.");
  expect(turnOffLine(2)).toBe("2 sessions close. Paired devices stay paired.");
});
