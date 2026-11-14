import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { Button, Dialog, Notice } from "@doriface/ui";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ListedSpace } from "./model.ts";
import { NotNowLine } from "./not-now-line.tsx";
import { closeCounts, closeRefusal, closeSpace, type SpaceCloseDrops, newTabRefusal } from "./space-close.ts";
import { SpaceCloseContext, type SpaceClosing } from "./space-close-context.ts";
import { sessionCalls } from "./session-actions.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

export interface SpaceCloseProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Terminal[];
  /** The machines' layouts, from which the space is taken. */
  readonly layouts: readonly MachineLayout[];
  /** The spaces as the sidebar lists them (layoutSpaces). */
  readonly spaces: readonly ListedSpace[];
  /** The space whose Close question is open (its sidebar menu), or null. */
  readonly ask: string | null;
  readonly onAsk: (id: string | null) => void;
  /** Records the sessions the close ends as dropped by its one write, and releases an End that failed. */
  readonly drops: SpaceCloseDrops;
  /** On a phone the question counts what the phone lists for the space (closeCounts). */
  readonly phone: boolean;
  readonly children: ReactNode;
}

const counted = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Closing spaces for everything inside it (SpaceCloseContext), and the question for the space asked about. */
export function SpaceClose({
  connection,
  terminals,
  layouts,
  spaces,
  ask,
  onAsk,
  drops,
  phone,
  children,
}: SpaceCloseProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The counts read as the question opens: they stay while the close takes the space out of the list behind it.
  const [asked, setAsked] = useState<{ id: string | null; name: string; tabs: number; terminals: number }>({
    id: null,
    name: "",
    tabs: 0,
    terminals: 0,
  });
  if (asked.id !== ask) {
    const space = ask === null ? undefined : spaces.find((each) => each.id === ask);
    setAsked({ id: ask, name: space?.name ?? "Space", ...closeCounts(space, terminals, phone) });
    setBusy(false);
    setError(null);
  }
  // Read when the close runs, so a question opened before the latest lists still closes the space as it is now.
  const latest = useRef({ terminals, layouts, spaces });
  latest.current = { terminals, layouts, spaces };
  // From this render's layouts, so the menu's Close follows the machine going and coming back.
  const closing = useMemo<SpaceClosing>(
    () => ({ ask: onAsk, refusal: (id) => closeRefusal(layouts, id), newRefusal: (id) => newTabRefusal(layouts, id) }),
    [onAsk, layouts],
  );
  // A question opened before the machine went away cannot close it now: Close waits, disabled, and comes back by itself.
  const refused = ask === null || busy ? null : closeRefusal(layouts, ask);
  const submit = (id: string): void => {
    const refusal = closeRefusal(latest.current.layouts, id);
    if (refusal !== null) return setError(refusal);
    const now = latest.current;
    setBusy(true);
    setError(null);
    closeSpace(sessionCalls(connection), now.layouts, now.spaces, now.terminals, id, drops).then(
      () => onAsk(null),
      (cause: unknown) => {
        setBusy(false);
        setError(messageOf(cause));
      },
    );
  };
  return (
    <SpaceCloseContext value={closing}>
      {children}
      {ask === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            // A close that is writing cannot be taken back: its question stays until the write settles (#1498).
            if (!open && !busy) onAsk(null);
          }}
          title="Close space?"
          description={`${asked.name} \u2014 ${counted(asked.tabs, "tab")}, ${counted(asked.terminals, "terminal")}`}
          actions={
            <>
              <Button variant="ghost" onClick={() => onAsk(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" loading={busy} disabled={refused !== null} onClick={() => submit(ask)}>
                Close
              </Button>
            </>
          }
        >
          {error !== null ? (
            <Notice tone="error" title="The space was not closed">
              {error}
            </Notice>
          ) : refused !== null ? (
            <NotNowLine action="Close" why={refused} />
          ) : undefined}
        </Dialog>
      )}
    </SpaceCloseContext>
  );
}
