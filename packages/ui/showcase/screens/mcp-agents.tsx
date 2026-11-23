import { useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogPanel,
  EmptyState,
  Fingerprint,
  GrantRow,
  SettingRow,
  Switch,
} from "../../src/index.ts";
import { MCP_GRANTS } from "../data.ts";
import { BoardFrame } from "./frames.tsx";
import { Group } from "./settings-sections.tsx";

const MCP_DESCRIPTION = "Lets a browser attach to studio with limited rights. Off closes every MCP session on studio.";

function AgentsOff() {
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

function AgentsEmpty() {
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
          title="No MCP client is attached to studio."
          actions={<Button variant="primary">Attach an MCP client</Button>}
        />
      </div>
    </div>
  );
}

function AgentsListed() {
  const [on, setOn] = useState(true);
  const [grants, setGrants] = useState(MCP_GRANTS);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removing = grants.find((grant) => grant.id === removingId);

  const resume = (id: string) => {
    setGrants((current) =>
      current.map((grant) => (grant.id === id ? { ...grant, state: "active", lastUsed: "Resumed just now" } : grant)),
    );
  };

  return (
    <div className="p-4 sm:p-6">
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          control={<Switch aria-label="MCP clients on studio" checked={on} onCheckedChange={setOn} />}
        />
        <div className="flex items-center justify-between gap-3 border-b border-border py-3">
          <h3 className="text-sm font-medium text-foreground">Attached clients</h3>
          <Button variant="primary" size="sm">
            Attach an MCP client
          </Button>
        </div>
        <div>
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              name={grant.name}
              kind={grant.kind}
              rights={grant.rights}
              state={grant.state}
              ends={grant.ends}
              {...(grant.lastUsed === undefined ? {} : { lastUsed: grant.lastUsed })}
              {...(grant.sessions === undefined ? {} : { sessions: grant.sessions })}
              onRemove={() => setRemovingId(grant.id)}
              {...(grant.state === "suspended" ? { onResume: () => resume(grant.id) } : {})}
              details={
                <div className="flex flex-col gap-2">
                  <Fingerprint label="Key fingerprint (SHA-256, truncated to 160 bits)" value={grant.fingerprint} />
                  <p>{grant.approvedBy}</p>
                </div>
              }
            />
          ))}
        </div>
      </Group>
      <Dialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingId(null);
        }}
        title={removing === undefined ? "" : `Remove ${removing.name} from studio?`}
        description="Its session closes at once and its key is never accepted again."
        actions={
          <>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== undefined) {
                  setGrants((current) => current.filter((entry) => entry.id !== removing.id));
                }
                setRemovingId(null);
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}

function RemoveDialogFrame() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <DialogPanel
        className="max-h-none w-full max-w-md overflow-visible"
        title="Remove Work laptop from studio?"
        description="Its session closes at once and its key is never accepted again."
        actions={
          <>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Remove</Button>
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
        description="2 sessions close. The attached clients stay listed."
        actions={
          <>
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Turn MCP off</Button>
          </>
        }
      />
    </div>
  );
}

function CannotManageFrame() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          disabledReason="studio is offline"
          control={(reason) => <Switch aria-label="MCP clients (studio is offline)" disabled {...reason} />}
        />
      </Group>
      <Group title="studio">
        <SettingRow
          inline
          title="MCP clients"
          description={MCP_DESCRIPTION}
          disabledReason="studio needs an update to attach MCP clients"
          control={(reason) => <Switch aria-label="MCP clients (older host)" disabled {...reason} />}
        />
      </Group>
    </div>
  );
}

/** Storyboard group A: Settings > Agents for one machine (studio), states A1 through A7. */
export function McpAgentsScreen() {
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-2 lg:p-8">
      <BoardFrame label="A1. Off (default)">
        <AgentsOff />
      </BoardFrame>
      <BoardFrame label="A2. On, nothing attached">
        <AgentsEmpty />
      </BoardFrame>
      <BoardFrame label="A3, A4. On, clients listed & row states">
        <AgentsListed />
      </BoardFrame>
      <BoardFrame label="A5. Remove">
        <RemoveDialogFrame />
      </BoardFrame>
      <BoardFrame label="A6. Turning off">
        <TurnOffDialogFrame />
      </BoardFrame>
      <BoardFrame label="A7. Cannot manage">
        <CannotManageFrame />
      </BoardFrame>
    </main>
  );
}
