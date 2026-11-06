import { ChevronLeft, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import {
  DirectionPad,
  ExtraKeysBar,
  IconButton,
  StatusChip,
  TerminalPreview,
  type TerminalLine,
} from "../../src/index.ts";
import { CLAUDE_LINES } from "../data.ts";
import { DEMO_KEYS } from "../keys.tsx";
import { PhoneFrame } from "./frames.tsx";
import { CompactHome } from "./shell.tsx";

/**
 * `overlay` pins over the terminal, `bottom` replaces the key bar, `action` sits before the actions menu, `pad` opens
 * the arrow pad over the terminal.
 */
export function MobileTerminal({
  lines = CLAUDE_LINES,
  overlay,
  bottom,
  action,
  pad = false,
}: {
  readonly lines?: readonly TerminalLine[];
  readonly overlay?: ReactNode;
  readonly bottom?: ReactNode;
  readonly action?: ReactNode;
  readonly pad?: boolean;
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
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
      {bottom ?? (
        <>
          {pad ? <DirectionPad className="absolute right-3 bottom-[calc(var(--safe-bottom)+4.25rem)]" /> : null}
          <ExtraKeysBar
            keys={DEMO_KEYS}
            latched={["ctrl"]}
            padOpen={pad}
            className="pb-[calc(var(--safe-bottom)+0.25rem)]"
          />
        </>
      )}
    </div>
  );
}

/** At 390 the route is the terminal itself; wider, both phone screens sit side by side. */
export function MobileScreen() {
  return (
    <>
      <div className="h-dvh md:hidden">
        <MobileTerminal pad />
      </div>
      <main className="hidden min-h-dvh items-center justify-center gap-12 bg-background p-10 md:flex">
        <PhoneFrame label="Agents">
          <CompactHome />
        </PhoneFrame>
        <PhoneFrame label="Terminal, with the keys bar and the arrow pad">
          <MobileTerminal pad />
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
