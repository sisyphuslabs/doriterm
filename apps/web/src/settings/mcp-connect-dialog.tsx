import { Button, Dialog } from "@doriface/ui";
import type { DesktopPairAnswer, PairOfferRequest } from "../desktop/pair-bridge.ts";
import { AgentInvite, usePairOffer } from "./agent-invite.tsx";

export interface McpConnectDialogProps {
  readonly open: boolean;
  /** Called when the dialog closes, with whether a client paired while it was open. */
  readonly onClose: (paired: boolean) => void;
  readonly pair: (request: PairOfferRequest) => Promise<DesktopPairAnswer>;
}

/**
 * Connects an MCP client to this computer in the two steps a person takes: pair the assistant's computer with the
 * host's own pairing offer, then paste the config that names this host. Nothing here is MCP-specific on the host: the
 * client is one more paired device.
 */
export function McpConnectDialog({ open, onClose, pair }: McpConnectDialogProps) {
  const offer = usePairOffer(pair, open);
  const { view, again } = offer;
  const close = (): void => {
    onClose(view.kind === "paired");
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
      <AgentInvite pair={pair} offer={offer} />
    </Dialog>
  );
}
