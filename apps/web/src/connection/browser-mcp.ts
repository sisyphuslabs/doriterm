import type { ByteLink } from "@doriface/client";
import { base64urlDecode, secureLink } from "@doriface/crypto";
import { isJsonObject } from "@doriface/protocol";
import { connectRelayClient } from "@doriface/relay-client";
import { BROWSER_DEPS } from "./relay-deps.ts";
import { isConfigured, type ConnectionSettings } from "./settings.ts";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

export async function openBrowserMcp(settings: ConnectionSettings, signal: AbortSignal): Promise<ByteLink> {
  if (settings.mode !== "relay" || settings.viewMember || !isConfigured(settings)) {
    throw new Error("Pair this browser with a host first.");
  }
  signal.throwIfAborted();
  const link = await connectRelayClient({ relayUrl: settings.relayUrl, hostId: settings.hostId, bestOf: 1, signal });
  const close = () => link.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const session = await secureLink(link, {
      role: "initiator",
      hostId: settings.hostId,
      staticKey: await BROWSER_DEPS.loadDeviceKey(),
      remoteStatic: base64urlDecode(settings.hostKey),
      stream: "mcp",
    });
    signal.throwIfAborted();
    return session;
  } catch (error) {
    close();
    throw error;
  } finally {
    signal.removeEventListener("abort", close);
  }
}

/** This one-shot probe issues one request at a time. It never evaluates or calls a tool supplied by the host. */
export async function listBrowserMcpTerminals(link: ByteLink, signal: AbortSignal): Promise<readonly string[]> {
  let id = 0;
  const request = (method: string, params: object) =>
    new Promise<unknown>((resolve, reject) => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let line = "";
      let bytes = 0;
      const requestId = ++id;
      const abort = () => end(undefined, new Error("MCP request cancelled."));
      const offClose = link.onClose((error) =>
        end(undefined, error ?? new Error("The host closed the MCP connection.")),
      );
      const offData = link.onData((chunk) => {
        try {
          bytes += chunk.length;
          if (bytes > 256 * 1024) throw new Error("MCP reply too large.");
          line += decoder.decode(chunk, { stream: true });
          if (!line.includes("\n")) return;
          const reply: unknown = JSON.parse(line);
          if (!isJsonObject(reply) || reply["jsonrpc"] !== "2.0" || reply["id"] !== requestId || !("result" in reply)) {
            throw new Error("The host did not accept the MCP request.");
          }
          end(reply["result"]);
        } catch (error) {
          end(undefined, error);
        }
      });
      function end(result: unknown, error?: unknown) {
        offData();
        offClose();
        signal.removeEventListener("abort", abort);
        if (error === undefined) resolve(result);
        else reject(error);
      }
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        link.send(
          new TextEncoder().encode(
            `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { ...params, _meta: meta } })}\n`,
          ),
        );
      } catch (error) {
        end(undefined, error);
      }
    });
  try {
    const discovery = await request("server/discover", {});
    if (
      !isJsonObject(discovery) ||
      !isJsonObject(discovery["capabilities"]) ||
      !("tools" in discovery["capabilities"])
    ) {
      throw new Error("This host does not offer MCP tools.");
    }
    const tools = await request("tools/list", {});
    if (
      !isJsonObject(tools) ||
      !Array.isArray(tools["tools"]) ||
      !tools["tools"].some((t: unknown) => isJsonObject(t) && t["name"] === "doriterm_call")
    ) {
      throw new Error("This host does not offer doriterm_call.");
    }
    const answer = await request("tools/call", {
      name: "doriterm_call",
      arguments: { tool: "terminal_list", arguments: {} },
    });
    if (
      !isJsonObject(answer) ||
      answer["isError"] !== false ||
      !isJsonObject(answer["structuredContent"]) ||
      !Array.isArray(answer["structuredContent"]["terminals"])
    ) {
      throw new Error("The host did not return a terminal list.");
    }
    return answer["structuredContent"]["terminals"].map((term: unknown) => {
      if (!isJsonObject(term) || typeof term["address"] !== "string") throw new Error("Invalid terminal address.");
      return term["address"];
    });
  } finally {
    link.close();
  }
}
