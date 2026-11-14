import { AgentRow, Button, EmptyState, IconButton, Menu, ScrollArea, SidebarSection } from "@doriface/ui";
import { ChevronLeft, Ellipsis, Plus, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { ListedSpace, Session } from "./model.ts";
import type { PhoneSection } from "./phone-route.ts";
import { spaceSummary, spaceTabRows } from "./phone-space-rows.ts";
import { QuietBusy } from "../terminal/quiet-busy.tsx";
import { TerminalsLoadError } from "./terminals-load-error.tsx";
import { ConnectionLine } from "./reconnect-status.tsx";
import { useSpaceClosing } from "./space-close-context.ts";
import { SpaceMenuItems } from "./space-actions.tsx";
import { useNow } from "./use-now.ts";
import { useKeptScroll } from "./kept-scroll.ts";
import { NotNowLine, notNowText } from "./not-now-line.tsx";

export interface PhoneSpaceProps {
  readonly space: ListedSpace;
  readonly terminals: readonly Session[];
  /** This machine's name, for a space on this machine. */
  readonly host: string;
  /** Reached by a push: it slides in. Reached by Back from a terminal over it, it is simply there again. */
  readonly arrive: boolean;
  /** The list it was opened from, where its Back goes. */
  readonly from: PhoneSection;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  /** Starts a terminal as a new tab of this space and opens it. */
  readonly onNew: () => void;
}

/**
 * A space on a phone: its running tabs, one row each, and New tab in it at the bottom, within thumb reach (#1387). It is
 * pushed over the list, so it slides in from the trailing edge (DESIGN.md 6, Standard); Back unmounts it at once.
 */
export function PhoneSpace({ space, terminals, host, arrive, from, onOpen, onBack, onNew }: PhoneSpaceProps) {
  const now = useNow();
  const closing = useSpaceClosing();
  const rows = spaceTabRows(space, terminals, now);
  // A space whose layout takes no edits (its machine is offline) can take no new tab and no close: both wait, disabled,
  // with why, and come back by themselves (#2455).
  const waiting = closing.refusal(space.id);
  // Back from a terminal opened here mounts this screen anew: its tabs come back where they were (#1553).
  const tabsViewport = useKeptScroll(`space:${space.id}`, rows.length > 0);
  return (
    <SpaceFrame
      arrive={arrive}
      from={from}
      onBack={onBack}
      actions={
        <Menu align="end" trigger={<IconButton label={`More for ${space.name}`} icon={<Ellipsis />} size="md" />}>
          <SpaceMenuItems space={space} reorder={undefined} />
        </Menu>
      }
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
          description={
            waiting === null
              ? "Its last tab ended. Start a shell or an agent here, or close the space."
              : notNowText(
                  waiting,
                  "New tab here and Close space come back by themselves once the machine can take them.",
                )
          }
          actions={
            <>
              <Button variant="primary" disabled={waiting !== null} onClick={onNew}>
                New tab here
              </Button>
              <Button disabled={waiting !== null} onClick={() => closing.ask(space.id)}>
                Close space
              </Button>
            </>
          }
        />
      ) : (
        <>
          <ScrollArea slot="space-tabs" className="flex-1" viewportRef={tabsViewport}>
            <div className="px-2 pt-2 pb-3">
              <SidebarSection title="Tabs" count={rows.length}>
                {rows.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} compactBlocked onSelect={onOpen} />
                ))}
              </SidebarSection>
            </div>
          </ScrollArea>
          <div className="flex shrink-0 flex-col gap-2 px-4 pt-2 pb-[max(1rem,calc(var(--safe-bottom)+0.5rem))]">
            {waiting === null ? null : <NotNowLine action="New tab" why={waiting} />}
            <Button
              variant="primary"
              size="lg"
              className="w-full [&>span]:min-w-0"
              disabled={waiting !== null}
              onClick={onNew}
            >
              <Plus aria-hidden />
              <span className="min-w-0 truncate">{`New tab in ${space.name}`}</span>
            </Button>
          </div>
        </>
      )}
    </SpaceFrame>
  );
}

/**
 * A space or a terminal the address names before the terminals are read (a cold open of `?s=` or `?t=`, #2532): its
 * screen, saying what it waits for, or, when the terminals could not be listed, why, with Try again (as the list says it).
 */
export function PhoneSpaceLoading(props: {
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly from: PhoneSection;
  readonly onBack: () => void;
  readonly terminal?: boolean;
}) {
  const [title, label] =
    props.terminal === true ? ["Terminal", "Opening the terminal"] : ["Space", "Loading the space"];
  return (
    <SpaceFrame arrive={false} from={props.from} onBack={props.onBack} title={<h1 className="sr-only">{title}</h1>}>
      {props.error === null ? (
        <QuietBusy label={label} text={`${label}…`} className="h-full" />
      ) : (
        <TerminalsLoadError cause={props.error} onRetry={props.onRetry} />
      )}
    </SpaceFrame>
  );
}

/** The space screen's frame: Back to the list and the title in the header, the content as the page's main landmark. */
function SpaceFrame(props: {
  readonly arrive: boolean;
  readonly from: PhoneSection;
  readonly onBack: () => void;
  readonly title: ReactNode;
  /** The space's own "..." at the header's end; none while the space is still loading. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  // The clip keeps the slide's first frames inside the screen: no sideways scroll or pan while it arrives.
  return (
    <div className="h-dvh overflow-x-clip">
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
            aria-label={`Back to ${props.from}`}
            className="gap-0.5 px-1.5 text-foreground"
            onClick={props.onBack}
          >
            <ChevronLeft aria-hidden />
            {props.from === "agents" ? "Agents" : "Spaces"}
          </Button>
          <div className="flex min-w-0 flex-1 flex-col py-1">{props.title}</div>
          {props.actions}
        </header>
        <ConnectionLine />
        <main className="flex min-h-0 flex-1 flex-col">{props.children}</main>
      </div>
    </div>
  );
}
