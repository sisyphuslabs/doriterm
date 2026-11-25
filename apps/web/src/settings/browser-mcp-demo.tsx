import { Button } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { listBrowserMcpTerminals, openBrowserMcp } from "../connection/browser-mcp.ts";
import { connectionStore } from "../connection/store.ts";

export function browserMcpDemoEnabled(location: Pick<Location, "hostname" | "search">): boolean {
  return (
    import.meta.env.VITE_BROWSER_MCP_PREVIEW === "1" &&
    location.hostname.endsWith(".workers.dev") &&
    new URLSearchParams(location.search).get("mcp-demo") === "1"
  );
}

export function BrowserMcpDemo() {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Pair this browser with a host, then list its terminals.");
  const [terminals, setTerminals] = useState<readonly string[]>([]);
  useEffect(() => () => active.current?.abort(), []);

  async function list() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const settings = connectionStore.settings;
    setTerminals([]);
    setBusy(true);
    setStatus(`Connecting to ${settings.hostName || "the paired host"}…`);
    try {
      const link = await openBrowserMcp(settings, signal);
      const addresses = await listBrowserMcpTerminals(link, signal);
      if (controller.signal.aborted) return;
      setTerminals(addresses);
      setStatus(`${addresses.length} terminals on ${settings.hostName || "the paired host"}. Disconnected.`);
    } catch {
      if (!controller.signal.aborted) {
        setStatus(
          "Could not list terminals. Check that the host is online, MCP is on, and this browser is still paired.",
        );
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" disabled={busy} onClick={() => void list()}>
        List terminals via MCP
      </Button>
      <p role="status" className="text-prose text-muted-foreground">
        {status}
      </p>
      {terminals.length > 0 && (
        <ul>
          {terminals.map((address) => (
            <li key={address}>{address}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
