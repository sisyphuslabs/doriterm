import { AgentRow, Button, EmptyState, ScrollArea, SidebarSection } from "@doriface/ui";
import { ChevronLeft, Plus, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { ListedSpace, Session } from "./model.ts";
import { spaceSummary, spaceTabRows } from "./phone-space-rows.ts";
import { QuietBusy } from "../terminal/quiet-busy.tsx";
import { ConnectionLine } from "./reconnect-status.tsx";
import { useSpaceClosing } from "./space-close-context.ts";
import { useNow } from "./use-now.ts";

export interface PhoneSpaceProps {
  readonly space: ListedSpace;
  readonly terminals: readonly Session[];
  /** This machine's name, for a space on this machine. */
  readonly host: string;
  /** Reached by a push: it slides in. Reached by Back from a terminal over it, it is simply there again. */
  readonly arrive: boolean;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  /** Starts a terminal as a new tab of this space and opens it. */
  readonly onNew: () => void;
}

/**
 * A space on a phone: its running tabs, one row each, and New tab in it at the bottom, within thumb reach (#1387). It is
 * pushed over the list, so it slides in from the trailing edge (DESIGN.md 6, Standard); Back unmounts it at once.
 */
export function PhoneSpace({ space, terminals, host, arrive, onOpen, onBack, onNew }: PhoneSpaceProps) {
  const now = useNow();
  const closing = useSpaceClosing();
  const rows = spaceTabRows(space, terminals, now);
  return (
    <SpaceFrame
      arrive={arrive}
      onBack={onBack}
      title={
        <>
          <h1 title={space.name} className="truncate text-base leading-tight font-semibold text-foreground">
            {space.name}
          </h1>
          <p className="truncate text-xs leading-tight text-muted-foreground">
            {spaceSummary(space.machine ?? host, rows)}
          </p>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          className="my-auto"
          icon={<SquareTerminal aria-hidden />}
          title={`Nothing is running in ${space.name}`}
          description="Its last tab ended. Start a shell or an agent here, or close the space."
          actions={
            <>
              <Button variant="primary" onClick={onNew}>
                New tab here
              </Button>
              <Button onClick={() => closing.ask(space.id)}>Close space</Button>
            </>
          }
        />
      ) : (
        <>
          <ScrollArea slot="space-tabs" className="flex-1">
            <div className="px-2 pt-2 pb-3">
              <SidebarSection title="Tabs" count={rows.length}>
                {rows.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} compactBlocked onSelect={onOpen} />
                ))}
              </SidebarSection>
            </div>
          </ScrollArea>
          <div className="shrink-0 px-4 pt-2 pb-[max(1rem,calc(var(--safe-bottom)+0.5rem))]">
            <Button variant="primary" size="lg" className="w-full [&>span]:min-w-0" onClick={onNew}>
              <Plus aria-hidden />
              <span className="min-w-0 truncate">{`New tab in ${space.name}`}</span>
            </Button>
          </div>
        </>
      )}
    </SpaceFrame>
  );
}

/** A space the address names before the spaces are read: its screen, saying what it waits for (a cold open of `?s=`). */
export function PhoneSpaceLoading({ onBack }: { readonly onBack: () => void }) {
  return (
    <SpaceFrame arrive={false} onBack={onBack} title={<h1 className="sr-only">Space</h1>}>
      <QuietBusy label="Loading the space" text="Loading the space…" className="h-full" />
    </SpaceFrame>
  );
}

/** The space screen's frame: Back to the list and the title in the header, the content as the page's main landmark. */
function SpaceFrame(props: {
  readonly arrive: boolean;
  readonly onBack: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      {...(props.arrive ? {} : { "data-arrived": "" })}
      className="motion-arrive flex h-dvh min-h-0 min-w-0 flex-col bg-sidebar pr-(--safe-right) pl-(--safe-left) [--arrive-from:translateX(1.5rem)]"
    >
      <header
        data-titlebar
        className="flex min-h-[calc(3rem+var(--safe-top))] shrink-0 items-center gap-2 border-b border-border pt-(--safe-top) pr-4 pl-[var(--titlebar-inset-start,0.375rem)]"
      >
        <Button
          variant="ghost"
          aria-label="Back to agents"
          className="gap-0.5 px-1.5 text-foreground"
          onClick={props.onBack}
        >
          <ChevronLeft aria-hidden />
          Agents
        </Button>
        <div className="flex min-w-0 flex-1 flex-col py-1">{props.title}</div>
      </header>
      <ConnectionLine />
      <main className="flex min-h-0 flex-1 flex-col">{props.children}</main>
    </div>
  );
}
