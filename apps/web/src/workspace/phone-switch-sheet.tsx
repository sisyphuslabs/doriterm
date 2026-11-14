import { AgentRow, Button, IconButton, SegmentedControl, Sheet, SidebarSection } from "@doriface/ui";
import { Plus, X } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { type ListedSpace, type Session, spaceOfAddress, toAgent } from "./model.ts";
import { NotNowLine } from "./not-now-line.tsx";
import { rowDetail, switchTabRows } from "./phone-space-rows.ts";
import { needsYouCount } from "./phone-tab-bar.tsx";
import { useSpaceSelection } from "./space-selection.ts";
import { useSpaceClosing } from "./space-close-context.ts";
import { useNow } from "./use-now.ts";

/** What the switch sheet lists: the open terminal's space, every tab that needs the person, or every space. */
type Shown = "space" | "needs" | "all";

/**
 * A space's rows, one per tab with a live terminal, for the terminal it opens: the open pane when it is this tab's, else
 * the tab's first live pane (with `needs`, the tab's pane that needs the person, and only tabs that have one). A row is
 * named by its tab, else by that terminal (never its place, #1387), and reads what that terminal said last.
 */
function tabRows(
  space: ListedSpace,
  terminals: readonly Session[],
  active: string,
  needs: boolean,
  nowMs: number,
  onPick: (address: string) => void,
  onClose: (address: string) => void,
): readonly ReactElement[] {
  // Two tabs can show terminals with one title (two agents both "claude"): their Close buttons then say which tab.
  return switchTabRows(space, terminals, active, needs).map(({ at, shown, name, closes }) => {
    const { detail: _where, ...agent } = toAgent(shown, nowMs);
    const said = rowDetail(space.tabNames[at] ?? "", shown);
    // Each row closes its tab as the desktop strip's close does, questions included (#1463).
    return (
      <div key={shown.address} className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <AgentRow
            agent={{
              ...agent,
              name,
              ...(said === "" ? {} : { detail: said }),
              ...(space.tabPins[at] === true ? { pinned: true } : {}),
            }}
            selected={shown.address === active}
            onSelect={onPick}
          />
        </div>
        <IconButton label={`Close ${closes}`} icon={<X />} size="md" onClick={() => onClose(shown.address)} />
      </div>
    );
  });
}

function needsLabel(count: number): ReactNode {
  return (
    <>
      Needs you
      {count === 0 ? null : (
        <span data-numeric className="font-semibold text-status-blocked-text">
          {count}
        </span>
      )}
    </>
  );
}

/** The sheet's body, mounted while it is open, so each opening starts on the open terminal's space. */
function SwitchList(props: {
  readonly terminals: readonly Session[];
  readonly active: string;
  readonly onPick: (address: string) => void;
  readonly onNewInSpace: (key: string) => void;
  readonly onCloseTab: (address: string) => void;
}) {
  const { terminals, active, onPick, onNewInSpace, onCloseTab } = props;
  // The layout documents' spaces, as the sidebar lists them (#404).
  const { spaces } = useSpaceSelection();
  const closing = useSpaceClosing();
  const now = useNow();
  const here = spaceOfAddress(spaces, active);
  const newWaiting = here === undefined ? null : closing.newRefusal(here.id);
  const [shown, setShown] = useState<Shown>(here === undefined ? "all" : "space");
  const needs = needsYouCount(terminals);
  const options = [
    ...(here === undefined
      ? []
      : [{ value: "space" as const, label: <span className="max-w-[9rem] truncate">{here.name}</span> }]),
    { value: "needs" as const, label: needsLabel(needs) },
    { value: "all" as const, label: "All spaces" },
  ];
  const sections = spaces.flatMap((space) => {
    const rows = tabRows(space, terminals, active, shown === "needs", now, onPick, onCloseTab);
    return rows.length === 0 && shown === "needs"
      ? []
      : [
          <SidebarSection
            key={space.id}
            title={space.machine === undefined ? space.name : `${space.machine} · ${space.name}`}
            count={rows.length}
          >
            {rows}
            {shown === "all" ? (
              <Button
                variant="ghost"
                className="h-11 justify-start gap-2 px-2 text-muted-foreground"
                disabled={closing.newRefusal(space.id) !== null}
                onClick={() => onNewInSpace(space.id)}
              >
                <Plus aria-hidden />
                New tab
              </Button>
            ) : null}
          </SidebarSection>,
        ];
  });
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl label="Show" options={options} value={shown} onValueChange={setShown} className="flex w-full" />
      {shown === "space" && here !== undefined ? (
        <section aria-label={here.name} className="flex flex-col">
          {tabRows(here, terminals, active, false, now, onPick, onCloseTab)}
        </section>
      ) : sections.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing needs you right now.</p>
      ) : (
        <div className="flex flex-col gap-4">{sections}</div>
      )}
      {here === undefined ? null : (
        <>
          {newWaiting === null ? null : <NotNowLine action="New tab" why={newWaiting} />}
          <Button
            variant="secondary"
            className="h-11 w-full gap-2"
            disabled={newWaiting !== null}
            onClick={() => onNewInSpace(here.id)}
          >
            <Plus aria-hidden />
            <span className="min-w-0 truncate">{`New tab in ${here.name}`}</span>
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The phone's switch sheet: the open terminal's space first, then Needs you and All spaces, and a new tab in that space
 * at its foot. Its open state is the route's (`&sheet=switch`), an entry of its own, so Back closes the sheet alone.
 */
export function SwitchSheet(props: {
  readonly terminals: readonly Session[];
  readonly active: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpen: (address: string) => void;
  /** Starts a new tab in the space with this key; the sheet closes first. */
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows `address`; the sheet stays open on what is left. */
  readonly onCloseTab: (address: string) => void;
  readonly trigger: ReactElement;
}) {
  const { terminals, active, open, onOpenChange, onOpen, onNewInSpace, onCloseTab, trigger } = props;
  return (
    <Sheet title="Switch" side="bottom" open={open} onOpenChange={onOpenChange} trigger={trigger}>
      <SwitchList
        terminals={terminals}
        active={active}
        onPick={onOpen}
        onCloseTab={onCloseTab}
        onNewInSpace={(key) => {
          onOpenChange(false);
          onNewInSpace(key);
        }}
      />
    </Sheet>
  );
}
