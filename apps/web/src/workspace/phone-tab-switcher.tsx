import { Button, IconButton } from "@doriface/ui";
import { ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { liveTabs, type Session, spaceOfAddress } from "./model.ts";
import { SwitchSheet } from "./phone-switch-sheet.tsx";
import { useSpaceSelection } from "./space-selection.ts";

/** The live tabs of the space whose tabs show `address`, each as its panes; empty when it is in no space's tab. */
export function useSpaceTabs(terminals: readonly Session[], address: string): readonly (readonly string[])[] {
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, address);
  return space === undefined ? [] : liveTabs(space, terminals);
}

/**
 * The phone's tab switcher within thumb reach (#466 10B): a bar at the bottom of the terminal screen that steps to the
 * space's previous and next tab and opens the switch sheet, with 44 px targets. herdr-app has no phone screen to follow,
 * so it sits where a phone keeps its toolbars; it leaves the terminal's own scrolling and selection alone. Its right end
 * is left to the round buttons (the keyboard button, and Read-only beside it), which float there level with it.
 */
export function PhoneTabSwitcher(props: {
  readonly terminals: readonly Session[];
  readonly tabs: readonly (readonly string[])[];
  readonly active: string;
  /** The open tab's name, else its terminal's title. */
  readonly title: string;
  readonly onOpen: (address: string) => void;
  /** How much of its right end the round button takes (ROUND_BUTTON_CLEARANCE); its controls stay clear of it. */
  readonly clearance: string;
  /** Whether the switch sheet is open, and its opening and closing (the route holds it). */
  readonly sheet: boolean;
  readonly onSheet: (open: boolean) => void;
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows `address`, as the desktop strip's close does (its questions included) (#1463). */
  readonly onCloseTab: (address: string) => void;
}) {
  const { terminals, tabs, active, title, onOpen, clearance, sheet, onSheet, onNewInSpace, onCloseTab } = props;
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, active)?.name;
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
      className="flex shrink-0 items-center gap-1 border-t border-border bg-chrome pt-1 pb-[max(1rem,calc(var(--safe-bottom)+0.5rem))] pl-1.5"
      style={{ paddingRight: clearance }}
    >
      {several ? <IconButton label="Previous tab" icon={<ChevronLeft />} size="md" onClick={() => step(-1)} /> : null}
      <SwitchSheet
        terminals={terminals}
        active={active}
        open={sheet}
        onOpenChange={onSheet}
        onOpen={onOpen}
        onNewInSpace={onNewInSpace}
        onCloseTab={onCloseTab}
        trigger={
          <Button
            variant="ghost"
            aria-label={`Switch tab, ${space === undefined ? "" : `${space}, `}${title}, tab ${at + 1} of ${tabs.length}`}
            className="@container h-12 min-w-0 flex-1 text-foreground [&>span]:min-w-0"
          >
            {/*
              The space goes first when the bar is narrow: the header already names it, and the tab's own name is what the
              stepper is for. The accessible name keeps it. At 390 px the bar leaves this button 390 - 6 (left padding) -
              ROUND_BUTTON_CLEARANCE 72 - 2 x 44 (Previous, Next) - 2 x 4 (gaps) = 216 px, over 13rem, so it keeps the space
              (the keys panel carries the keyboard's toggle, so one round button is beside the bar, #2499); at 320 px it is
              146 px and drops it. A change to the round button or the steppers moves these numbers:
              phone-session-title.e2e.ts pins the 390 end.
            */}
            {space === undefined ? null : (
              <span title={space} className="min-w-0 shrink-[2] truncate font-semibold @max-[13rem]:hidden">
                {`${space} ·`}
              </span>
            )}
            <span title={title} className="min-w-0 truncate font-normal">
              {title}
            </span>
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
