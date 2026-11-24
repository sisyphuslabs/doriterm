import { useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogPanel,
  EmptyState,
  McpClientRow,
  SettingRow,
  Switch,
} from "../../src/index.ts";
import { MCP_CLIENTS } from "../data.ts";
import { BoardFrame } from "./frames.tsx";
import { Group } from "./settings-sections.tsx";

const MCP_DESCRIPTION = "Lets a paired device speak MCP to studio. Off closes every MCP session on studio.";

function ClientsOff() {
  const [on, setOn] = useState(false);
  return (
    <div className="p-4 sm:p-6">
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          control={<Switch aria-label="MCP clients on studio" checked={on} onCheckedChange={setOn} />}
        />
      </Group>
    </div>
  );
}

function ClientsEmpty() {
  const [on, setOn] = useState(true);
  return (
    <div className="flex flex-1 flex-col p-4 sm:p-6">
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          control={<Switch aria-label="MCP clients on studio" checked={on} onCheckedChange={setOn} />}
        />
      </Group>
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          title="No MCP client is connected to studio."
          actions={
            <Button type="button" variant="primary">
              Connect an MCP client
            </Button>
          }
        />
      </div>
    </div>
  );
}

function ClientsListed() {
  const [on, setOn] = useState(true);
  const [clients, setClients] = useState(MCP_CLIENTS);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const disconnecting = clients.find((client) => client.id === disconnectingId);

  return (
    <div className="p-4 sm:p-6">
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          control={<Switch aria-label="MCP clients on studio" checked={on} onCheckedChange={setOn} />}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3">
          <h3 className="text-sm font-medium text-foreground">Connected clients</h3>
          <Button type="button" variant="primary" size="sm">
            Connect an MCP client
          </Button>
        </div>
        <div>
          {clients.map((client) => (
            <McpClientRow
              key={client.id}
              name={client.name}
              connected={client.connected}
              onDisconnect={() => setDisconnectingId(client.id)}
              details={
                <div className="flex flex-col gap-1">
                  <p>
                    Device ID <code className="font-mono text-foreground">{client.deviceId}</code>
                  </p>
                  <p>{client.paired}</p>
                </div>
              }
            />
          ))}
        </div>
      </Group>
      <Dialog
        open={disconnecting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDisconnectingId(null);
        }}
        title={disconnecting === undefined ? "" : `Disconnect ${disconnecting.name} from studio?`}
        description="Its sessions close at once and it has to pair again."
        actions={
          <>
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (disconnecting !== undefined) {
                  setClients((current) => current.filter((entry) => entry.id !== disconnecting.id));
                }
                setDisconnectingId(null);
              }}
            >
              Disconnect
            </Button>
          </>
        }
      />
    </div>
  );
}

function DisconnectDialogFrame() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <DialogPanel
        className="max-h-none w-full max-w-md overflow-visible"
        title="Disconnect Pickle from studio?"
        description="Its sessions close at once and it has to pair again."
        actions={
          <>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
            <Button type="button" variant="destructive">
              Disconnect
            </Button>
          </>
        }
      />
    </div>
  );
}

function TurnOffDialogFrame() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <DialogPanel
        className="max-h-none w-full max-w-md overflow-visible"
        title="Turn MCP off on studio?"
        description="2 sessions close. Paired devices stay paired."
        actions={
          <>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
            <Button type="button" variant="primary">
              Turn MCP off
            </Button>
          </>
        }
      />
    </div>
  );
}

function CannotManageFrame() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <section aria-label="studio" className="flex flex-col">
        <h2 className="pb-1 text-lg font-semibold text-muted-foreground md:text-xl">studio</h2>
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          disabledReason="studio is offline"
          control={(reason) => <Switch aria-label="MCP clients (studio is offline)" disabled {...reason} />}
        />
      </section>
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          disabledReason="studio needs an update to accept MCP clients"
          control={(reason) => <Switch aria-label="MCP clients (older host)" disabled {...reason} />}
        />
      </Group>
    </div>
  );
}

/** Storyboard group A: Settings > MCP clients for one machine (studio), states A1 through A6. */
export function McpAgentsScreen() {
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-2 lg:p-8">
      <BoardFrame label="A1. Off (default)">
        <ClientsOff />
      </BoardFrame>
      <BoardFrame label="A2. On, nothing connected">
        <ClientsEmpty />
      </BoardFrame>
      <BoardFrame label="A3. On, clients listed">
        <ClientsListed />
      </BoardFrame>
      <BoardFrame label="A4. Disconnect">
        <DisconnectDialogFrame />
      </BoardFrame>
      <BoardFrame label="A5. Turning off">
        <TurnOffDialogFrame />
      </BoardFrame>
      <BoardFrame label="A6. Cannot manage">
        <CannotManageFrame />
      </BoardFrame>
    </main>
  );
}
