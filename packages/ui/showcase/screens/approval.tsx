import { ApprovalBanner, type ApprovalBannerState, type TerminalLine } from "../../src/index.ts";
import { APPROVAL_PROMPT, CLAUDE_ALLOWED_LINES, CLAUDE_PERMISSION_LINES, CLAUDE_PROMPT_GONE_LINES } from "../data.ts";
import { BoardFrame, StateSection, TerminalCrop } from "./frames.tsx";
import { MobileTerminal } from "./mobile.tsx";
import { Sidebar, WorkspaceBody } from "./shell.tsx";

const STATES: readonly {
  readonly label: string;
  readonly state: ApprovalBannerState;
  readonly lines: readonly TerminalLine[];
}[] = [
  { label: "Waiting", state: { kind: "waiting" }, lines: CLAUDE_PERMISSION_LINES },
  {
    label: "Sending: Allow pressed, checking the live screen first",
    state: { kind: "sending", answer: "allow" },
    lines: CLAUDE_PERMISSION_LINES,
  },
  { label: "Stale: the prompt went away, nothing sent", state: { kind: "stale" }, lines: CLAUDE_PROMPT_GONE_LINES },
  {
    label: "Answered (on another device)",
    state: { kind: "answered", answer: "allow", where: "from iPhone" },
    lines: CLAUDE_ALLOWED_LINES,
  },
];

const banner = (state: ApprovalBannerState) => <ApprovalBanner prompt={APPROVAL_PROMPT} state={state} />;

/** #192: the permission banner pinned over the terminal, in context and in every state. */
export function ApprovalScreen() {
  return (
    <main className="min-h-dvh bg-background">
      <div data-density="coarse" className="h-[844px] md:hidden">
        <MobileTerminal lines={CLAUDE_PERMISSION_LINES} overlay={banner({ kind: "waiting" })} />
      </div>
      <div data-density="coarse" className="md:hidden">
        {STATES.slice(1).map((entry) => (
          <StateSection key={entry.label} label={entry.label}>
            <TerminalCrop lines={entry.lines} overlay={banner(entry.state)} className="h-72" />
          </StateSection>
        ))}
      </div>
      <div className="hidden h-[900px] md:flex">
        <Sidebar />
        <WorkspaceBody claudeLines={CLAUDE_PERMISSION_LINES} claude={{ overlay: banner({ kind: "waiting" }) }} />
      </div>
      <div className="hidden grid-cols-2 gap-6 border-t border-border p-8 md:grid">
        {STATES.map((entry) => (
          <BoardFrame key={entry.label} label={entry.label}>
            <TerminalCrop lines={entry.lines} overlay={banner(entry.state)} />
          </BoardFrame>
        ))}
      </div>
    </main>
  );
}
