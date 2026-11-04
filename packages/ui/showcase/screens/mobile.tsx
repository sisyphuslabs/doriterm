import { ChevronLeft, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { ExtraKeysBar, IconButton, StatusChip, TerminalPreview, type TerminalLine } from "../../src/index.ts";
import { CLAUDE_LINES } from "../data.ts";
import { PhoneFrame } from "./frames.tsx";
import { CompactHome } from "./shell.tsx";

/** `overlay` pins over the terminal, `bottom` replaces the key bar, `action` sits before the actions menu. */
export function MobileTerminal({
  lines = CLAUDE_LINES,
  overlay,
  bottom,
  action,
}: {
  readonly lines?: readonly TerminalLine[];
  readonly overlay?: ReactNode;
  readonly bottom?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="box-content flex h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5 pt-(--safe-top)">
        <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-base font-semibold text-foreground">Claude Code</h1>
          <StatusChip status="blocked" />
        </div>
        {action}
        <IconButton label="Terminal actions" icon={<Ellipsis />} size="md" />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TerminalPreview lines={lines} cursor label="Claude Code output" className="flex-1 text-[0.75rem]" />
        {overlay === undefined ? null : <div className="absolute inset-x-2 top-2">{overlay}</div>}
      </div>
      {bottom ?? <ExtraKeysBar latched={["ctrl"]} />}
    </div>
  );
}

/** At 390 the route is the terminal itself; wider, both phone screens sit side by side. */
export function MobileScreen() {
  return (
    <>
      <div className="h-dvh md:hidden">
        <MobileTerminal />
      </div>
      <main className="hidden min-h-dvh items-center justify-center gap-12 bg-background p-10 md:flex">
        <PhoneFrame label="Agents">
          <CompactHome />
        </PhoneFrame>
        <PhoneFrame label="Terminal, with the extra keys bar">
          <MobileTerminal />
        </PhoneFrame>
      </main>
    </>
  );
}

/** At 390 the agents list is the screen; wider, it is shown in a phone frame instead of stretching. */
export function MobileAgentsScreen() {
  return (
    <>
      <div className="h-dvh md:hidden">
        <CompactHome />
      </div>
      <main className="hidden min-h-dvh items-center justify-center bg-background p-10 md:flex">
        <PhoneFrame label="Agents">
          <CompactHome />
        </PhoneFrame>
      </main>
    </>
  );
}
