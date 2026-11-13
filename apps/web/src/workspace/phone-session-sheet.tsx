import { Button, IconButton, Sheet, cn } from "@doriface/ui";
import { CircleAlert, Ellipsis, Pencil, Power, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { runAction } from "../keys/dispatcher.ts";
import { nextNeedingYou, waitingBesides } from "./attention.ts";
import type { Session } from "./model.ts";
import { useAskSession } from "./session-context.ts";

export interface PhoneSessionSheetProps {
  readonly terminal: Session;
  readonly terminals: readonly Session[];
  /** The session's name, as the header's heading reads it: its tab's own name, else the terminal's title. */
  readonly title: string;
  /** Where it lives: machine and space, as the header's second line says it. */
  readonly where: string;
  readonly onOpen: (address: string) => void;
}

function Row(props: {
  readonly icon: ReactNode;
  readonly destructive?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      onClick={props.onClick}
      className={cn(
        // A long label (the next agent, with its count) wraps rather than running past a 320 px sheet.
        "h-auto min-h-11 justify-start gap-3 px-2 py-2 text-left text-base whitespace-normal text-foreground",
        props.destructive === true && "text-destructive hover:text-destructive",
      )}
    >
      {props.icon}
      {props.children}
    </Button>
  );
}

/** Where the session lives: machine and space, then its directory; no directory line when the terminal reports none. */
export function SessionPlace({ where, dir }: { readonly where: string; readonly dir: string | undefined }) {
  return (
    <div data-session-place className="flex flex-col gap-0.5 pb-2">
      <p className="text-sm text-muted-foreground">{where}</p>
      {dir ? <p className="font-mono text-xs break-all text-muted-foreground">{dir}</p> : null}
    </div>
  );
}

/**
 * The phone header's "..." for the session in view (#1467): one bottom sheet that says where it lives, then the next
 * agent that needs you and, while its machine is online, Find in terminal, then Rename and End. Each row closes the
 * sheet before it acts.
 */
export function PhoneSessionSheet({ terminal, terminals, title, where, onOpen }: PhoneSessionSheetProps) {
  const [open, setOpen] = useState(false);
  const ask = useAskSession();
  const { address } = terminal;
  const next = nextNeedingYou(terminals, address);
  const nextAgent = next === null || next === address ? null : next;
  const waiting = waitingBesides(terminals, address);
  // While its machine is offline the line under the header says so (MachineLine) and the row waits for the machine to
  // come back: Find in terminal is offered again then (#1482).
  const offline = terminal.offline === true;
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <Sheet
      title={title}
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={<IconButton label={`Session actions for ${title}`} icon={<Ellipsis />} size="md" />}
    >
      <SessionPlace where={where} dir={terminal.foreground?.cwd ?? terminal.cwd} />
      {nextAgent === null && offline ? null : (
        <div className="flex flex-col border-t border-border pt-1">
          {nextAgent === null ? null : (
            <Row icon={<CircleAlert aria-hidden />} onClick={act(() => onOpen(nextAgent))}>
              Open the next agent that needs you ({waiting})
            </Row>
          )}
          {offline ? null : (
            <Row icon={<Search aria-hidden />} onClick={act(() => runAction("terminal.search"))}>
              Find in terminal
            </Row>
          )}
        </div>
      )}
      <div className="flex flex-col border-t border-border pt-1">
        <Row icon={<Pencil aria-hidden />} onClick={act(() => ask({ kind: "rename", address }))}>
          Rename…
        </Row>
        <Row icon={<Power aria-hidden />} destructive onClick={act(() => ask({ kind: "end", address }))}>
          End session…
        </Row>
      </div>
    </Sheet>
  );
}
