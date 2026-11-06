import { CloudOff, KeyRound, WifiOff } from "lucide-react";
import { Button, DialogPanel, EmptyState, Fingerprint, Notice } from "../../src/index.ts";
import { BoardFrame } from "./frames.tsx";

export function HostOffline() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<WifiOff />}
        title="studio is offline"
        description="Last seen 4 minutes ago. Agents keep running on the host, and Doriterm reconnects when it is back."
        actions={
          <>
            <Button variant="primary">Try again</Button>
            <Button variant="ghost">Switch host</Button>
          </>
        }
      />
    </div>
  );
}

export function RelayUnreachable() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <Notice
        tone="warning"
        title="Can't reach the relay"
        actions={
          <Button size="sm" variant="primary">
            Retry
          </Button>
        }
      >
        relay-doriface.omo.dev did not answer. On the host's network you can connect directly instead.
      </Notice>
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<CloudOff />}
          title="No connection to studio"
          description="Your terminals are still there. They show up again as soon as a route works."
          actions={<Button variant="secondary">Connect directly on LAN</Button>}
        />
      </div>
    </div>
  );
}

export function FingerprintMismatch() {
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <DialogPanel
        title={
          <span className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-destructive" /> The host's key changed
          </span>
        }
        description="studio answered with a key this device has never seen. If you did not reinstall the host, someone may be in between."
        actions={
          <>
            <Button variant="ghost" className="text-destructive">
              Trust the new key…
            </Button>
            <Button variant="primary">Disconnect</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 rounded-md bg-raised p-3">
          <p className="text-xs font-medium text-foreground">Host key fingerprint (SHA-256, truncated to 160 bits)</p>
          <Fingerprint label="Expected" value="3fa94c0e7b21d8559e04a6c17f3bd2a08c4e6f19" />
          <Fingerprint label="Received" value="3fa94c0e91c4d8559e04b0f27f3bd2a08c4e6f19" mismatched={[2, 5]} />
        </div>
      </DialogPanel>
    </div>
  );
}

export function StatesScreen() {
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-3 lg:p-8">
      <BoardFrame label="Host offline" className="min-h-[36rem]">
        <HostOffline />
      </BoardFrame>
      <BoardFrame label="Relay unreachable" className="min-h-[36rem]">
        <RelayUnreachable />
      </BoardFrame>
      <BoardFrame label="Host key mismatch" className="min-h-[36rem]">
        <FingerprintMismatch />
      </BoardFrame>
    </main>
  );
}
