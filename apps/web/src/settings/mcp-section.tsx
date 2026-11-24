import { Button, Dialog, McpClientRow, SettingRow, Switch } from "@doriface/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopDevices } from "../desktop/device-bridge.ts";
import { desktopMcp, type DesktopMcpAnswer, type DesktopMcpClient } from "../desktop/mcp-bridge.ts";
import { desktopPairOffer } from "../desktop/pair-bridge.ts";
import { McpConnectDialog } from "./mcp-connect-dialog.tsx";
import { clientName, mcpView, turnOffLine, type McpView } from "./mcp-view.ts";

const DESCRIPTION =
  "Lets a paired device speak MCP to this computer, so an assistant can use its terminals. Off closes every MCP session.";

export interface McpClientsProps {
  readonly view: McpView;
  readonly busy: boolean;
  readonly note: string | null;
  readonly onSwitch: (on: boolean) => void;
  readonly onConnect: (() => void) | null;
  readonly onDisconnect: (client: DesktopMcpClient) => void;
}

/** The section as it reads for one state; the state comes from the host, and every act is a callback. */
export function McpClients({ view, busy, note, onSwitch, onConnect, onDisconnect }: McpClientsProps) {
  const connect =
    onConnect === null ? null : (
      <Button variant="primary" size="sm" onClick={onConnect}>
        Connect an MCP client
      </Button>
    );
  return (
    <>
      {view.kind === "unavailable" || view.kind === "asking" ? (
        <SettingRow
          inline
          title="MCP clients"
          description={DESCRIPTION}
          disabledReason={view.kind === "asking" ? "Asking this computer's host…" : view.reason}
          // Controlled here too: the same switch becomes the live one once the host answers, and one that started
          // uncontrolled would keep showing off.
          control={(reason) => (
            <Switch aria-label="MCP clients on this computer" checked={false} disabled {...reason} />
          )}
        />
      ) : (
        <SettingRow
          inline
          title="MCP clients"
          description={DESCRIPTION}
          control={
            <Switch
              aria-label="MCP clients on this computer"
              checked={view.kind === "on"}
              disabled={busy}
              onCheckedChange={onSwitch}
            />
          }
        />
      )}
      {view.kind !== "on" ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3">
            <h3 className="text-sm font-medium text-foreground">
              {view.clients.length === 0 ? "No MCP client is connected to this computer." : "Connected clients"}
            </h3>
            {connect}
          </div>
          {view.clients.map((client, index) => (
            <McpClientRow
              // One device may hold several sessions, so the id alone does not name a row.
              key={`${client.id}-${index}`}
              name={clientName(client)}
              connected="Connected now"
              onDisconnect={() => onDisconnect(client)}
              details={
                <p>
                  Device ID <code className="font-mono text-foreground">{client.id}</code>
                </p>
              }
            />
          ))}
        </>
      )}
      {note === null ? null : (
        <p role="status" className="text-prose text-muted-foreground">
          {note}
        </p>
      )}
    </>
  );
}

/**
 * This computer's MCP switch, the clients connected through it, and the way to connect or disconnect one. It draws
 * nothing unless this app runs on its own host: the shell relays every answer from the running doriface-host.
 */
export function McpSection() {
  const mcp = useMemo(() => desktopMcp(), []);
  const devices = useMemo(() => desktopDevices(), []);
  const pair = useMemo(() => desktopPairOffer(), []);
  const [answer, setAnswer] = useState<DesktopMcpAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [disconnecting, setDisconnecting] = useState<DesktopMcpClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const view = mcpView(answer);

  const ask = useCallback(
    async (request: "state" | "on" | "off"): Promise<void> => {
      if (mcp === null) return;
      setBusy(true);
      try {
        setAnswer(await mcp(request));
      } catch (error) {
        setAnswer({ state: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(false);
      }
    },
    [mcp],
  );
  useEffect(() => {
    void ask("state");
  }, [ask]);

  if (mcp === null) return null;

  const disconnect = async (client: DesktopMcpClient): Promise<void> => {
    setDisconnecting(null);
    if (devices === null) return;
    try {
      const revoked = await devices.revoke(client.id);
      setNote(
        revoked.state === "revoked"
          ? `${revoked.device.name} can no longer reach this computer.`
          : revoked.state === "not-found"
            ? "That client is not a device paired here. Remove a mesh member under Mesh."
            : revoked.reason,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
    await ask("state");
  };

  return (
    <>
      <McpClients
        view={view}
        busy={busy}
        note={note}
        onSwitch={(on) => {
          setNote(null);
          if (!on && view.kind === "on" && view.clients.length > 0) return setTurningOff(true);
          void ask(on ? "on" : "off");
        }}
        onConnect={pair === null ? null : () => setConnecting(true)}
        onDisconnect={setDisconnecting}
      />
      <Dialog
        open={turningOff}
        alert
        title="Turn MCP off on this computer?"
        description={turnOffLine(view.kind === "on" ? view.clients.length : 0)}
        className="w-[min(28rem,calc(100%-2rem))]"
        onOpenChange={(next) => {
          if (!next) setTurningOff(false);
        }}
        actions={
          <>
            <Button variant="ghost" onClick={() => setTurningOff(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setTurningOff(false);
                void ask("off");
              }}
            >
              Turn MCP off
            </Button>
          </>
        }
      />
      <Dialog
        open={disconnecting !== null}
        alert
        title={`Disconnect ${disconnecting === null ? "this client" : clientName(disconnecting)}?`}
        description="Its sessions close at once and it has to pair again."
        className="w-[min(28rem,calc(100%-2rem))]"
        onOpenChange={(next) => {
          if (!next) setDisconnecting(null);
        }}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDisconnecting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (disconnecting !== null) void disconnect(disconnecting);
              }}
            >
              Disconnect
            </Button>
          </>
        }
      />
      {pair === null ? null : (
        <McpConnectDialog
          open={connecting}
          pair={pair}
          onClose={() => {
            setConnecting(false);
            void ask("state");
          }}
        />
      )}
    </>
  );
}
