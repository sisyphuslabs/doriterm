import { base64urlDecode, fingerprintOf } from "@doriface/crypto";
import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { deviceIdOf, DeviceStore } from "../state/devices.ts";
import { defaultStateDir, isRecord } from "../state/files.ts";
import { McpSwitch } from "../state/mcp-switch.ts";
import { printable } from "./devices.ts";

export const MCP_USAGE = "usage: doriface-host mcp on|off|status [--state-dir <dir>]";

async function showSessions(stateDir: string, out: (text: string) => void): Promise<void> {
  const reply = await requestControl(stateDir, { op: "mcp-status" });
  if (reply === undefined) return out("the host is not running\n");
  if (!isRecord(reply) || !Array.isArray(reply["sessions"])) throw new Error("bad MCP status reply");
  const sessions: readonly unknown[] = reply["sessions"];
  if (sessions.length === 0) return out("no MCP client is connected\n");
  const devices = new Map(new DeviceStore(stateDir).list().map((device) => [device.clientStaticPub, device]));
  for (const session of sessions) {
    if (!isRecord(session) || typeof session["key"] !== "string") throw new Error("bad MCP status reply");
    const key = session["key"];
    const device = devices.get(key);
    const id =
      device === undefined ? fingerprintOf(base64urlDecode(key)).replaceAll(" ", "").slice(0, 8) : deviceIdOf(device);
    out(`${id}  ${device === undefined ? "(mesh client)" : printable(device.name)}\n`);
  }
}

export async function mcpCommand(args: readonly string[], out: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out(`${MCP_USAGE}\n`);
    return 0;
  }
  const [action, ...extra] = positionals;
  if (extra.length > 0 || (action !== "on" && action !== "off" && action !== "status")) {
    throw new Error(`unknown MCP command: ${positionals.join(" ")}`);
  }
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const mcp = new McpSwitch(stateDir);
  if (action === "status") {
    out(mcp.enabled() ? "MCP is on\n" : "MCP is off\n");
    await showSessions(stateDir, out);
    return 0;
  }
  mcp.setEnabled(action === "on");
  if (action === "on") {
    out("MCP is on: a paired device may open an MCP session on this machine\n");
  } else {
    out("MCP is off: its sessions are closed, and paired devices stay paired\n");
    await requestControl(stateDir, { op: "mcp-changed" });
  }
  return 0;
}
