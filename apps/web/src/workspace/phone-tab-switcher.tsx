import { AgentRow, Button, IconButton, Sheet, SidebarSection } from "@doriface/ui";
import { ChevronLeft, ChevronRight, ChevronUp, Plus, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { liveTabs, type Session, terminalTitle, titledTabs, toAgent } from "./model.ts";
import { useSpaceSelection } from "./space-selection.ts";
import { useNow } from "./use-now.ts";

/** A bottom sheet of every space with its tabs; picking a tab opens it on the phone. */
export function SpaceSheet(props: {
  readonly terminals: readonly Session[];
  readonly active: string;
  readonly onOpen: (address: string) => void;
  /** Closes the tab that shows `address`, as the desktop strip's close does (its questions included) (#1463). */
  readonly onCloseTab: (address: string) => void;
  /** Starts a terminal in a new tab of that space. */
  readonly onNewInSpace: (space: string) => void;
  readonly trigger: ReactElement;
}) {
  const { terminals, active, onOpen, onCloseTab, onNewInSpace, trigger } = props;
  // The layout documents' spaces, as the sidebar lists them (#404).
  const { spaces } = useSpaceSelection();
  const [open, setOpen] = useState(false);
  const now = useNow();
  const pick = (address: string): void => {
    setOpen(false);
    onOpen(address);
  };
  return (
    <Sheet title="Spaces" side="bottom" open={open} onOpenChange={setOpen} trigger={trigger}>
      <div className="flex flex-col gap-4">
        {spaces.map((space) => (
          <SidebarSection
            key={space.id}
            title={space.machine === undefined ? space.name : `${space.machine} · ${space.name}`}
            count={space.tabs}
          >
            {/*
              One row per tab, named as the strip names it (its name, else its number), the terminal it opens after it:
              the open pane when it is this tab's, else the tab's first live pane.
            */}
            {titledTabs(space, terminals).flatMap(({ title, panes }) => {
              const shown = panes.includes(active) ? active : panes[0];
              return terminals
                .filter((entry) => entry.address === shown)
                .map((entry) => (
                  <div key={entry.address} className="flex min-w-0 items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <AgentRow
                        agent={{ ...toAgent(entry, now), name: title, detail: terminalTitle(entry) }}
                        selected={entry.address === active}
                        onSelect={pick}
                      />
                    </div>
                    <IconButton
                      label={`Close ${title}`}
                      icon={<X />}
                      size="md"
                      onClick={() => onCloseTab(entry.address)}
                    />
                  </div>
                ));
            })}
            <Button
              variant="ghost"
              className="h-11 justify-start gap-2 px-2 text-muted-foreground"
              onClick={() => {
                setOpen(false);
                onNewInSpace(space.id);
              }}
            >
              <Plus aria-hidden />
              New tab
            </Button>
          </SidebarSection>
        ))}
      </div>
    </Sheet>
  );
}

/** The live tabs of the space whose tabs show `address`, each as its panes; empty when it is in no space's tab. */
export function useSpaceTabs(terminals: readonly Session[], address: string): readonly (readonly string[])[] {
  const { spaces } = useSpaceSelection();
  const space = spaces.find((each) => each.addresses.includes(address));
  return space === undefined ? [] : liveTabs(space, terminals);
}

/**
 * The phone's tab switcher within thumb reach (#466 10B): a bar at the bottom of the terminal screen that steps to the
 * space's previous and next tab and opens the spaces sheet, with 44 px targets. herdr-app has no phone screen to follow,
 * so it sits where a phone keeps its toolbars; it leaves the terminal's own scrolling and selection alone. Its right end
 * is left to the round keyboard button, which floats there level with it.
 */
export function PhoneTabSwitcher(props: {
  readonly terminals: readonly Session[];
  readonly tabs: readonly (readonly string[])[];
  readonly active: string;
  /** The open tab as the strip reads it: its name, else its number. */
  readonly title: string;
  readonly onOpen: (address: string) => void;
  readonly onCloseTab: (address: string) => void;
  readonly onNewInSpace: (space: string) => void;
}) {
  const { terminals, tabs, active, title, onOpen, onCloseTab, onNewInSpace } = props;
  const at = tabs.findIndex((panes) => panes.includes(active));
  if (at === -1) return null;
  const step = (by: 1 | -1): void => {
    const next = tabs[(at + by + tabs.length) % tabs.length]?.[0];
    if (next !== undefined) onOpen(next);
  };
  const several = tabs.length > 1;
  return (
    <nav
      aria-label="Tabs in this space"
      data-phone-tabs
      className="flex shrink-0 items-center gap-1 border-t border-border bg-chrome pt-1 pr-[4.5rem] pb-[max(1rem,calc(var(--safe-bottom)+0.5rem))] pl-1.5"
    >
      {several ? <IconButton label="Previous tab" icon={<ChevronLeft />} size="md" onClick={() => step(-1)} /> : null}
      <SpaceSheet
        terminals={terminals}
        active={active}
        onOpen={onOpen}
        onCloseTab={onCloseTab}
        onNewInSpace={onNewInSpace}
        trigger={
          <Button
            variant="ghost"
            aria-label={`Switch tab, ${title}, tab ${at + 1} of ${tabs.length}`}
            className="h-12 min-w-0 flex-1 text-foreground [&>span]:min-w-0"
          >
            <span className="min-w-0 truncate font-semibold">{title}</span>
            <span data-numeric className="shrink-0 text-xs text-muted-foreground">
              {`${at + 1}/${tabs.length}`}
            </span>
            <ChevronUp aria-hidden className="text-muted-foreground" />
          </Button>
        }
      />
      {several ? <IconButton label="Next tab" icon={<ChevronRight />} size="md" onClick={() => step(1)} /> : null}
    </nav>
  );
}
