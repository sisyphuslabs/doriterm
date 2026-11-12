import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { Button, Dialog, useToastManager } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { useTerminalConfig } from "../ghostty/config-store.ts";
import { single } from "../ghostty/config.ts";
import { terminalInput } from "./focus-targets.ts";
import type { LayoutTab } from "./layout-model.ts";
import { asksBeforeClosing } from "./model.ts";
import { routedPendingEnds } from "./pending-ends.ts";
import { recordedEnd } from "./resume-ends.ts";
import { sessionCalls } from "./session-actions.ts";

export interface CloseTabDialogProps {
  readonly connection: HcConnection;
  /** The machines as last listed, read when End runs (#2314): a prop, so this dialog never re-renders on a machines update of its own (#2076). */
  readonly views: readonly MachineView[];
  readonly terminals: readonly Terminal[];
  readonly tab: LayoutTab;
  /** The space whose last tab this is: closing it closes the space, as herdr-app's `tab.close`, and always asks first. */
  readonly space?: { readonly name: string };
  /** Several tabs closing together (#1561): `tab` holds all their panes, and the question names how many tabs. */
  readonly tabs?: number;
  /** Takes the tab out of the layout: at once, while its sessions end behind it. */
  readonly onClosed: () => void;
  readonly onDone: () => void;
  /** A session whose End failed keeps running, so its later end drops its pane again. */
  readonly onKept: (address: string) => void;
}

const counted = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Why the Ends that failed did not, and where the sessions they kept are shown again: the tab is gone as they fail, so
 * they run with no tab to show them until they are adopted again, a few seconds after End takes its mark off them
 * (#1278, #2122).
 */
function endsFailed(failed: number, cause: unknown): { readonly title: string; readonly description: string } {
  const why = (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, "");
  return failed === 1
    ? {
        title: "The session did not end",
        description: `${why}. It keeps running outside any tab, and opens as a tab again within a few seconds.`,
      }
    : {
        title: `${failed} sessions did not end`,
        description: `${why}. They keep running outside any tab, and open as tabs again within a few seconds.`,
      };
}

/**
 * Closing a space's last tab closes the space, as herdr-app's `space.close` asks: "Close space?", naming its tabs and
 * terminals, and Close ends them. Closing a tab of several panes ends all of their programs, as in herdr-app and Ghostty. It asks once first only as
 * confirm-close-surface says (while one of them runs a program, by default). The tab leaves as Close is chosen, not a
 * round trip or a kill escalation later (#1271); an End that fails is reported in a toast, the one surface left once
 * the tab is gone.
 */
export function CloseTabDialog({
  connection,
  views,
  terminals,
  tab,
  space,
  tabs = 1,
  onClosed,
  onDone,
  onKept,
}: CloseTabDialogProps) {
  const toasts = useToastManager();
  // Asked with focus on the page body (a terminal whose renderer had not started yet), or from an element gone by now,
  // the question gives focus to the focused pane's terminal, as the session's own question does.
  const [opener] = useState(() => document.activeElement);
  const backTo = (): HTMLElement | true =>
    opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? true : (terminalInput() ?? true);
  const shown = new Set(tab.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])));
  const live = terminals.filter((terminal) => shown.has(terminal.address) && terminal.state === "live");
  const count = live.length;
  const asks = asksBeforeClosing(single(useTerminalConfig(), "confirm-close-surface"), live);
  const quiet = space === undefined && !asks;
  const end = (): void => {
    const calls = sessionCalls(connection);
    // Kept in local storage until each End settles, so a page closed before the tab's Ends leave it has the next page
    // finish them (#1278): the tab is gone at once, and its sessions must not be adopted back as a new one.
    const ends = routedPendingEnds({ core: connection.hello.core.id, machines: views });
    const ending = Promise.allSettled(
      live.map((terminal) =>
        recordedEnd(
          ends,
          { address: terminal.address, pid: terminal.pid ?? null, created: terminal.created_ms, at: Date.now() },
          calls,
        ).catch((cause: unknown) => {
          onKept(terminal.address);
          throw cause;
        }),
      ),
    );
    onClosed();
    onDone();
    const report = async (): Promise<void> => {
      const outcomes = await ending;
      const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
      if (failures.length === 0) return;
      const [first] = failures;
      toasts.add({ type: "error", ...endsFailed(failures.length, first) });
    };
    void report();
  };
  const endedQuietly = useRef(false);
  useEffect(() => {
    if (count === 0 && space === undefined) {
      onClosed();
      onDone();
      return;
    }
    if (!quiet || endedQuietly.current) return;
    endedQuietly.current = true;
    end();
  });
  if ((count === 0 && space === undefined) || quiet) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      finalFocus={backTo}
      title={space !== undefined ? "Close space?" : tabs > 1 ? `Close ${tabs} tabs?` : "Close this tab?"}
      description={
        space !== undefined
          ? `${space.name} \u2014 ${counted(1, "tab")}, ${counted(shown.size, "terminal")}`
          : count === 1
            ? "The running program will end."
            : `Its ${count} sessions will end.`
      }
      actions={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={end}>
            Close
          </Button>
        </>
      }
    />
  );
}
