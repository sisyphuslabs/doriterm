import { ChevronLeft, Ellipsis } from "lucide-react";
import { DirectionPad, ExtraKeysBar, IconButton, StatusChip, TerminalPreview } from "../../src/index.ts";
import { CLAUDE_LINES } from "../data.ts";
import { PhoneFrame } from "./frames.tsx";
import { CompactHome } from "./shell.tsx";

export function MobileTerminal() {
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
      <header className="box-content flex h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5 pt-(--safe-top)">
        <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-base font-semibold text-foreground">Claude Code</h1>
          <StatusChip status="blocked" />
        </div>
        <IconButton label="Terminal actions" icon={<Ellipsis />} size="md" />
      </header>
      <TerminalPreview lines={CLAUDE_LINES} cursor label="Claude Code output" className="flex-1 text-[0.75rem]" />
      <DirectionPad className="absolute right-3 bottom-[calc(var(--safe-bottom)+4.25rem)]" />
      <ExtraKeysBar latched={["ctrl"]} padOpen className="pb-[calc(var(--safe-bottom)+0.25rem)]" />
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
        <PhoneFrame label="Terminal, with the keys bar and the arrow pad">
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
