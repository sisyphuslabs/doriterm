import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { Button, Dialog, Notice } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { useTerminalConfig } from "../ghostty/config-store.ts";
import { single } from "../ghostty/config.ts";
import { terminalInput } from "./focus-targets.ts";
import { asksBeforeClosing, terminalTitle } from "./model.ts";
import { titleAndProgram, useShown } from "./use-shown.ts";
import { RenameDialog } from "./rename-dialog.tsx";
import { routedPendingEnds } from "./pending-ends.ts";
import { recordedEnd } from "./resume-ends.ts";
import { endSession, renameSession, sessionCalls, takeBackEnd } from "./session-actions.ts";
import type { SessionAsk } from "./session-context.ts";

export interface SessionDialogsProps {
  readonly connection: HcConnection;
  /** The machines as last listed, read when End runs (#2314): a prop, so this dialog never re-renders on a machines update of its own (#2076). */
  readonly views: readonly MachineView[];
  readonly terminals: readonly Terminal[];
  readonly ask: SessionAsk | null;
  readonly onDone: () => void;
  /** Takes a session's pane out of the layout: as a close is chosen, else once the session is gone. */
  readonly onDrop: (address: string) => void;
  /** A close's End failed: the session keeps running, so its later end drops its pane again. */
  readonly onKept: (address: string) => void;
}

const COPY = {
  end: "The program stops and its output is gone. This cannot be undone.",
  close: "The running program will end.",
} as const;

const ENDED = {
  rename: "It ended before you answered, so there is nothing to rename.",
  end: "It ended before you answered, so there is nothing to end.",
  close: "It ended before you answered, so there is nothing to close.",
} as const;

/**
 * The rename, end and close-tab questions for one session. A session that ends while its question is open turns the
 * question into a statement that it ended, with only OK: the question never disappears on its own, and nothing is
 * answered for the user. A question asked about a session that had already ended needs no answer and closes.
 */
export function SessionDialogs({ connection, views, terminals, ask, onDone, onDrop, onKept }: SessionDialogsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The question open now: an action settles into the question that started it, never into a later one.
  const askNow = useRef(ask);
  askNow.current = ask;
  const listed = ask === null ? undefined : terminals.find((entry) => entry.address === ask.address);
  const [terminal] = useShown(listed === undefined ? [] : [listed], titleAndProgram);
  const live = terminal?.state === "live";
  const current = terminal === undefined ? null : terminalTitle(terminal);
  // Read while the question renders, before it takes focus: the element it gives focus back to when it closes, and the
  // name it asks with. The title can change before the session ends (a rename, or the shell's name giving way to its
  // argv as it exits), and the question and its statement name what was asked about.
  const [asked, setAsked] = useState<{
    readonly ask: SessionAsk | null;
    readonly opener: Element | null;
    readonly name: string | null;
  }>({ ask: null, opener: null, name: null });
  if (asked.ask !== ask) setAsked({ ask, opener: document.activeElement, name: current });
  // A session that stops meanwhile needs no answer and gets a statement instead (below), except that a question whose
  // action is still running stays up until it settles, and one whose action failed stays up to say why, even if the
  // session left the list, so the user can try again.
  const keep = busy || error !== null;
  // The question that has seen its session live: when that session ends, the user is told rather than left wondering.
  const [liveAsk, setLiveAsk] = useState<SessionAsk | null>(null);
  useEffect(() => {
    if (live) setLiveAsk(ask);
  }, [ask, live]);
  const ended = ask !== null && ask === liveAsk && !live && !keep;
  useEffect(() => {
    if (ask === null || keep || live) return;
    // The closed tab's session is gone either way; dropping its tab is tidying up, not an answer.
    if (ask.kind === "close") onDrop(ask.address);
    if (ask !== liveAsk) onDone();
  }, [ask, keep, live, liveAsk, onDone, onDrop]);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [ask]);
  const run = (work: () => Promise<void>, after: () => void): void => {
    const started = ask;
    if (started === null) return;
    setBusy(true);
    work().then(
      () => (askNow.current === started ? after() : undefined),
      (cause: unknown) => {
        const why = cause instanceof Error ? cause.message : String(cause);
        // Left with Cancel meanwhile: the question it would answer is gone, and the one open now is about something else.
        if (askNow.current !== started) return console.error(`${started.kind} ${started.address}: ${why}`);
        setBusy(false);
        setError(why);
      },
    );
  };
  // Kept in local storage until it settles, so a page closed before End's calls leave it has the next page finish it.
  const end = (): void => {
    if (ask === null) return;
    const { address } = ask;
    const calls = sessionCalls(connection);
    const record = terminal === undefined ? null : { address, pid: terminal.pid ?? null, created: terminal.created_ms };
    const ending = (): Promise<void> =>
      record === null
        ? endSession(calls, address)
        : recordedEnd(
            routedPendingEnds({ core: connection.hello.core.id, machines: views }),
            { ...record, at: Date.now() },
            calls,
          );
    const closing = ask.kind === "close";
    run(
      () =>
        ending().catch((cause: unknown) => {
          if (closing) onKept(address);
          throw cause;
        }),
      onDone,
    );
    // A close takes the pane and its question away as it is chosen, not a round trip or a kill escalation later (#1271):
    // End is already recorded, and a failed one still brings its question back to say why.
    if (!closing) return;
    endedQuietly.current = ask;
    onDrop(address);
  };
  // Closing ends the program, as in herdr-app and Ghostty; it asks first only as confirm-close-surface says. A close
  // that needs no question ends at once, and the question shows only to say why that End failed.
  const confirm = single(useTerminalConfig(), "confirm-close-surface");
  const quiet = ask?.kind === "close" && terminal !== undefined && live && !asksBeforeClosing(confirm, [terminal]);
  const endedQuietly = useRef<SessionAsk | null>(null);
  useEffect(() => {
    if (!quiet || endedQuietly.current === ask) return;
    endedQuietly.current = ask;
    end();
  });
  if (ask === null || !(live || keep || ended)) return null;
  // A close whose End is under way shows no question while that End settles: one that needed no question, and one
  // whose question was answered (its question goes as Close is chosen, #1271), also once the terminal has left the
  // list (which ends `quiet`); it shows only to say why that End failed (#518).
  if ((quiet || endedQuietly.current === ask) && error === null) return null;
  const title = (asked.ask === ask ? asked.name : null) ?? current ?? "";
  // Asked with focus on the page body (a terminal whose renderer had not started yet), or from an element that is gone
  // by now, the question gives focus to the focused pane's terminal instead of leaving keys with nowhere to go.
  const { opener } = asked;
  const backTo = (): HTMLElement | true =>
    opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? true : (terminalInput() ?? true);
  if (ended) {
    return (
      <Dialog
        alert
        open
        onOpenChange={(open) => {
          if (!open) onDone();
        }}
        finalFocus={backTo}
        title={`${title} already ended`}
        description={ENDED[ask.kind]}
        actions={
          <Button variant="primary" onClick={onDone}>
            OK
          </Button>
        }
      />
    );
  }
  // Left after a failed End, the session runs on: it must not keep End's mark, which a dropped link may have kept.
  const dismiss = (): void => {
    if (error !== null && live) {
      const { address } = ask;
      takeBackEnd(sessionCalls(connection), address).catch((cause: unknown) =>
        console.error(`take End's mark off ${address}: ${String(cause)}`),
      );
    }
    onDone();
  };
  if (ask.kind === "rename") {
    return (
      <RenameDialog
        title={title}
        busy={busy}
        error={error}
        onCancel={onDone}
        onRename={(name) => run(() => renameSession(sessionCalls(connection), ask.address, name), onDone)}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      finalFocus={backTo}
      title={ask.kind === "end" ? `End ${title}?` : `Close ${title}?`}
      description={COPY[ask.kind]}
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <Button variant="destructive" loading={busy} onClick={end}>
            {ask.kind === "close" ? "Close" : "End session"}
          </Button>
        </>
      }
    >
      {error === null ? undefined : (
        <Notice tone="error" title="The session did not end">
          {`${error.replace(/\.$/, "")}. ${
            ask.kind === "close"
              ? "It keeps running outside any pane, and opens as a tab of its own within a few seconds."
              : "It keeps running."
          }`}
        </Notice>
      )}
    </Dialog>
  );
}
