import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, CopyBlock, DialogPanel, QrCode, Spinner, cn, type DialogPanelProps } from "../../src/index.ts";
import { sampleQrModules } from "../data.ts";
import { BoardFrame } from "./frames.tsx";

const CONNECT_COMMAND = "doriface-host connect '<link>'";
const MCP_CONFIG_JSON =
  '{ "mcpServers": { "doriterm": { "command": "doriface-host", "args": ["connect", "--mcp", "5k2n…q7ra"] } } }';

function Panel({ className, ...props }: DialogPanelProps) {
  return <DialogPanel {...props} className={cn("max-h-none w-full max-w-md overflow-visible p-4 sm:p-5", className)} />;
}

function StepFrame({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <BoardFrame label={label}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-3 sm:p-6">{children}</div>
    </BoardFrame>
  );
}

function InviteCodeBox() {
  return (
    <div className="w-full rounded-lg border border-border bg-raised px-4 py-2.5 text-center">
      <span className="block text-xs font-medium text-muted-foreground">Invite code</span>
      <span className="font-mono text-xl font-semibold tracking-widest text-foreground select-all">F7K3 9D2M</span>
    </div>
  );
}

function PairStep() {
  const [linkCopied, setLinkCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  return (
    <Panel
      title="Connect an MCP client to studio"
      description="It pairs like a phone and gets what a paired device gets on studio: it can read and type into your terminals, run commands and write files."
      actions={
        <Button type="button" variant="ghost">
          Close
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <QrCode modules={sampleQrModules()} label="MCP invite QR code" className="w-44 border border-border p-1" />
        <Button type="button" variant="primary" onClick={() => setLinkCopied(true)}>
          {linkCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span className="grid place-items-center">
            <span
              className={cn("col-start-1 row-start-1", linkCopied && "invisible")}
              aria-hidden={linkCopied || undefined}
            >
              Copy link
            </span>
            <span
              className={cn("col-start-1 row-start-1", !linkCopied && "invisible")}
              aria-hidden={!linkCopied || undefined}
            >
              Copied
            </span>
          </span>
        </Button>
        <InviteCodeBox />
        <p data-numeric="" className="text-xs text-muted-foreground">
          Expires in 9:41 · works once
        </p>
        <div className="flex w-full flex-col gap-1.5">
          <p className="text-prose text-pretty text-muted-foreground">On the assistant's computer:</p>
          <CopyBlock
            label="Connect command"
            text={CONNECT_COMMAND}
            copied={commandCopied}
            onCopy={() => setCommandCopied(true)}
          />
        </div>
      </div>
    </Panel>
  );
}

function WaitingStep() {
  return (
    <Panel
      title={
        <span className="flex items-start gap-2.5">
          <Spinner className="mt-2 text-muted-foreground" />
          <span>Waiting for the client to pair.</span>
        </span>
      }
      actions={
        <Button type="button" variant="ghost">
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-3">
        <InviteCodeBox />
        <p data-numeric="" className="text-xs text-muted-foreground">
          Expires in 9:41 · works once
        </p>
      </div>
    </Panel>
  );
}

function PairedStep() {
  const [copied, setCopied] = useState(false);
  return (
    <Panel
      title="Pickle is paired with studio."
      actions={
        <Button type="button" variant="primary">
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-prose text-pretty text-muted-foreground">Paste this into the assistant's MCP settings:</p>
        <CopyBlock
          label="MCP settings config"
          copyLabel="Copy config"
          text={MCP_CONFIG_JSON}
          copied={copied}
          onCopy={() => setCopied(true)}
        />
      </div>
    </Panel>
  );
}

/** Storyboard group B: Connect an MCP client dialog, steps B1 through B4. */
export function McpAttachScreen() {
  const reopen = (
    <>
      <Button type="button" variant="ghost">
        Close
      </Button>
      <Button type="button" variant="primary">
        Open a new invite
      </Button>
    </>
  );
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-2 lg:p-8">
      <StepFrame label="B1. Pair">
        <PairStep />
      </StepFrame>
      <StepFrame label="B2. Waiting">
        <WaitingStep />
      </StepFrame>
      <StepFrame label="B3. Paired">
        <PairedStep />
      </StepFrame>
      <StepFrame label="B4. Did not pair">
        <Panel title="This invite expired." actions={reopen} />
        <Panel title="This invite was used." actions={reopen} />
      </StepFrame>
    </main>
  );
}
