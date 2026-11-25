import { Button, CopyBlock, Dialog, Notice } from "@doriface/ui";
import { useEffect, useState } from "react";
import type { DesktopPairAnswer } from "../desktop/pair-bridge.ts";
import { useNow } from "../workspace/use-now.ts";
import { connectCommand, mcpConfig } from "./mcp-view.ts";
import { expiryLine, offerCode, pairDeviceView, slotNote } from "./pair-device.ts";

/** How often the dialog asks the host what stands while an invite is live. */
const POLL_MS = 1_000;

export interface McpConnectDialogProps {
  readonly open: boolean;
  /** Called when the dialog closes, with whether a client paired while it was open. */
  readonly onClose: (paired: boolean) => void;
  readonly pair: (request: "open" | "state") => Promise<DesktopPairAnswer>;
}

/**
 * Connects an MCP client to this computer in the two steps a person takes: pair the assistant's computer with the
 * host's own pairing offer, then paste the config that names this host. Nothing here is MCP-specific on the host: the
 * client is one more paired device.
 */
export function McpConnectDialog({ open, onClose, pair }: McpConnectDialogProps) {
  const [answer, setAnswer] = useState<DesktopPairAnswer | null>(null);
  // The offer names this host; the config needs that id after the offer itself is gone.
  const [hostId, setHostId] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [copied, setCopied] = useState<"command" | "config" | null>(null);
  const now = useNow(POLL_MS);
  const view = pairDeviceView(answer, now);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (request: "open" | "state"): Promise<void> => {
      if (cancelled) return;
      try {
        const next = await pair(request);
        if (cancelled) return;
        setAnswer(next);
        if (next.state === "pending") {
          setHostId(next.offer.hostId);
          if (Date.now() < next.offer.expiresAt) timer = setTimeout(() => void poll("state"), POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setAnswer({ state: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      }
    };
    void poll("open");
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, pair, round]);

  const again = (): void => {
    setCopied(null);
    setAnswer(null);
    setRound((value) => value + 1);
  };
  const close = (): void => {
    onClose(view.kind === "paired");
    setAnswer(null);
    setCopied(null);
  };
  const copy = async (what: "command" | "config", text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };
  const retry = view.kind === "expired" || view.kind === "unavailable";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={view.kind === "paired" ? "The client is paired" : "Connect an MCP client"}
      description={
        view.kind === "paired"
          ? undefined
          : "It pairs like a phone and gets what a paired device gets on this computer: it can read and type into your terminals, run commands and write files."
      }
      className="w-[min(30rem,calc(100%-2rem))]"
      actions={
        <>
          <Button variant={view.kind === "paired" ? "primary" : "ghost"} onClick={close}>
            {view.kind === "paired" ? "Done" : "Close"}
          </Button>
          {retry ? (
            <Button variant="primary" onClick={again}>
              Open a new invite
            </Button>
          ) : null}
        </>
      }
    >
      {view.kind === "asking" ? (
        <p className="text-prose text-muted-foreground">Asking this computer's host for an invite…</p>
      ) : view.kind === "offer" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-prose text-pretty text-muted-foreground">On the assistant's computer, run once:</p>
            <CopyBlock
              label="Connect command"
              text={connectCommand(view.offer.link)}
              copied={copied === "command"}
              onCopy={() => void copy("command", connectCommand(view.offer.link))}
            />
          </div>
          <div className="w-full rounded-lg border border-border bg-raised px-4 py-2.5 text-center">
            <span className="block text-xs font-medium text-muted-foreground">Or type this code there</span>
            <span data-pair-code className="font-mono text-xl font-semibold tracking-widest text-foreground select-all">
              {offerCode(view.offer)}
            </span>
          </div>
          {slotNote(view.offer) === undefined ? null : (
            <p className="text-prose text-pretty text-muted-foreground">{slotNote(view.offer)}</p>
          )}
          <p data-numeric="" className="text-xs text-muted-foreground">
            {expiryLine(view.offer, now)} It works once.
          </p>
        </div>
      ) : view.kind === "paired" ? (
        <div className="flex flex-col gap-3">
          <p className="text-prose text-pretty text-muted-foreground">
            {view.device === null ? "A device" : view.device.name} is paired with this computer.
            {hostId === null ? "" : " Paste this into the assistant's MCP settings:"}
          </p>
          {hostId === null ? null : (
            <CopyBlock
              label="MCP settings config"
              copyLabel="Copy config"
              text={mcpConfig(hostId)}
              copied={copied === "config"}
              onCopy={() => void copy("config", mcpConfig(hostId))}
            />
          )}
        </div>
      ) : view.kind === "expired" ? (
        <Notice tone="warning" title="This invite expired">
          Open a new one to connect a client.
        </Notice>
      ) : (
        <Notice tone="warning" title="This computer's host did not answer">
          {view.reason}
        </Notice>
      )}
    </Dialog>
  );
}
