import { Check, Copy, FolderPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Button,
  DialogPanel,
  MatchCode,
  Notice,
  QrCode,
  RightRow,
  SegmentedControl,
  cn,
  type DialogPanelProps,
  type SegmentOption,
} from "../../src/index.ts";
import { sampleQrModules } from "../data.ts";
import { BoardFrame } from "./frames.tsx";

type Scope = "own" | "chosen" | "all";
type Expiry = "1d" | "7d" | "30d" | "90d";

const SPACES = ["api-server", "web-client", "release-notes"];
const TEMPLATES = ["claude", "codex", "shell"];
const SCOPES: readonly SegmentOption<Scope>[] = [
  { value: "own", label: "Only what it starts" },
  { value: "chosen", label: "Chosen spaces" },
  { value: "all", label: "All" },
];
const EXPIRIES: readonly SegmentOption<Expiry>[] = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const pairActions = (ghost: string, primary: string) => (
  <>
    <Button variant="ghost">{ghost}</Button>
    <Button variant="primary">{primary}</Button>
  </>
);

function useRight() {
  const [enabled, onEnabledChange] = useState(true);
  const [mode, onModeChange] = useState<"ask" | "allow">("ask");
  return { enabled, onEnabledChange, mode, onModeChange };
}

function useMulti(initial: readonly string[]) {
  const [selected, setSelected] = useState(initial);
  const onToggle = (item: string) =>
    setSelected((list) => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]));
  return { selected, onToggle };
}

function Panel({ wide = false, className, ...props }: DialogPanelProps & { readonly wide?: boolean }) {
  const width = wide ? "max-w-xl" : "max-w-md";
  return <DialogPanel {...props} className={cn("max-h-none w-full overflow-visible p-4 sm:p-5", width, className)} />;
}

function StepFrame({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <BoardFrame label={label}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-3 sm:p-6">{children}</div>
    </BoardFrame>
  );
}

function Picker({
  label,
  options,
  selected,
  onToggle,
}: {
  readonly label: string;
  readonly options: readonly string[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const picked = selected.includes(option);
        const edge = picked ? "border-input bg-selected" : "border-border";
        return (
          <Button
            key={option}
            size="sm"
            variant={picked ? "secondary" : "ghost"}
            aria-pressed={picked}
            onClick={() => onToggle(option)}
            className={cn("border", edge)}
          >
            {picked ? <Check aria-hidden /> : null}
            {option}
          </Button>
        );
      })}
    </div>
  );
}

function RightsAndExpiryStep() {
  const [scope, setScope] = useState<Scope>("chosen");
  const spaces = useMulti(["api-server", "web-client"]);
  const templates = useMulti(["claude"]);
  const [filesOn, setFilesOn] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>("30d");
  const send = useRight();
  const startTemplate = useRight();
  const endTerminals = useRight();
  const addFolder = (
    <Button variant="secondary" size="sm" onClick={() => setFilesOn(true)}>
      <FolderPlus /> Add a folder
    </Button>
  );
  return (
    <Panel wide title="What may it do on studio?" actions={pairActions("Cancel", "Open invite")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Terminals</span>
          <SegmentedControl
            compact
            label="Terminals"
            value={scope}
            onValueChange={setScope}
            className="w-full"
            options={SCOPES}
          />
          {scope === "chosen" ? <Picker label="Chosen spaces" options={SPACES} {...spaces} /> : null}
        </div>
        <div className="flex flex-col border-y border-border">
          <RightRow title="Read" enabled />
          <RightRow title="Send text and keys" {...send} />
          <RightRow title="Start a template" {...startTemplate}>
            <Picker label="Templates" options={TEMPLATES} {...templates} />
          </RightRow>
          <RightRow title="End terminals" {...endTerminals} allowLabel="Allow for its own" />
          <RightRow title="Files" enabled={filesOn} onEnabledChange={setFilesOn}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-raised px-2 py-1 font-mono text-xs text-foreground">~/api-server</span>
              {addFolder}
            </div>
          </RightRow>
          {filesOn ? null : <div className="pb-3">{addFolder}</div>}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Ends after</span>
          <SegmentedControl
            compact
            label="Ends after"
            value={expiry}
            onValueChange={setExpiry}
            className="w-full"
            options={EXPIRIES}
          />
        </div>
        <p className="text-prose text-pretty text-muted-foreground">
          It never gets a raw terminal, another machine, or your own terminals.
        </p>
      </div>
    </Panel>
  );
}

function InviteOpenStep() {
  const [copied, setCopied] = useState(false);
  const actions = (
    <>
      <Button variant="ghost">Close</Button>
      <Button variant="primary" onClick={() => setCopied(true)}>
        <Copy /> {copied ? "Copied" : "Copy link"}
      </Button>
    </>
  );
  return (
    <Panel title="Attach an MCP client" description="Open it in the browser to attach." actions={actions}>
      <div className="flex flex-col items-center gap-4">
        <QrCode modules={sampleQrModules()} label="MCP invite QR code" className="w-44 border border-border p-1" />
        <div className="w-full rounded-lg border border-border bg-raised px-4 py-2.5 text-center">
          <span className="block text-xs font-medium text-muted-foreground">Invite code</span>
          <span className="font-mono text-xl font-semibold tracking-widest text-foreground select-all">F7K3 9D2M</span>
        </div>
        <p data-numeric="" className="text-xs text-muted-foreground">
          Expires in 9:41 · works once
        </p>
      </div>
    </Panel>
  );
}

function RequestArrivedStep() {
  const send = useRight();
  const startTemplate = useRight();
  return (
    <Panel wide title="Work laptop (browser) asks to attach." actions={pairActions("The codes differ", "Approve")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col border-y border-border">
          <RightRow title="Read" description="api-server, web-client" enabled />
          <RightRow title="Send text and keys" {...send} />
          <RightRow title="Start a template" description="claude" {...startTemplate} />
        </div>
        <MatchCode code="482 913" label="Match code" />
        <Notice tone="warning" title="Approve only if the other screen shows the same code.">
          Look at it, or ask by a call. Not in the chat that carried the link.
        </Notice>
      </div>
    </Panel>
  );
}

/** Storyboard group B: the owner's Attach an MCP client dialog, steps B1 through B6. */
export function McpAttachScreen() {
  const reopen = pairActions("Close", "Open invite");
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-2 lg:p-8">
      <StepFrame label="B1. Rights and expiry">
        <RightsAndExpiryStep />
      </StepFrame>
      <StepFrame label="B2. Invite open">
        <InviteOpenStep />
      </StepFrame>
      <StepFrame label="B3. A request arrived">
        <RequestArrivedStep />
      </StepFrame>
      <StepFrame label="B4. Waiting">
        <Panel title="Waiting for Work laptop to confirm the code." actions={<Button variant="ghost">Cancel</Button>}>
          <MatchCode code="482 913" label="Match code" className="w-full" />
        </Panel>
      </StepFrame>
      <StepFrame label="B5. Attached">
        <Panel
          title="Work laptop is attached to studio. Ends 23 Dec."
          actions={<Button variant="primary">Done</Button>}
        />
      </StepFrame>
      <StepFrame label="B6. Not attached">
        <Panel title="Not attached." description="The invite is spent. Open a new one." actions={reopen} />
        <Panel title="This invite expired." actions={reopen} />
      </StepFrame>
    </main>
  );
}
