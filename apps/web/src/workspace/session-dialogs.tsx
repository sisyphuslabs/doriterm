import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { Button, Dialog, Notice } from "@doriface/ui";
import { useEffect, useState } from "react";
import { terminalInput } from "./focus-targets.ts";
import { terminalTitle } from "./model.ts";
import { RenameDialog } from "./rename-dialog.tsx";
import { endSession, renameSession, sessionCalls, takeBackEnd } from "./session-actions.ts";
import type { SessionAsk } from "./session-context.ts";

export interface SessionDialogsProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Terminal[];
  readonly ask: SessionAsk | null;
  readonly onDone: () => void;
  /** Hides the tab and leaves the program running. */
  readonly onKeep: (address: string) => void;
}

const COPY = {
  end: "The program stops and its output is gone. This cannot be undone.",
  close: "Keep it running and reopen it from the sidebar any time, or end the program now.",
} as const;

/** The rename, end and close-tab questions for one session; a session that stops meanwhile needs no answer. */
export function SessionDialogs({ connection, terminals, ask, onDone, onKeep }: SessionDialogsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read while the question renders, before it takes focus: the element it gives focus back to when it closes.
  const [asked, setAsked] = useState<{ readonly ask: SessionAsk | null; readonly opener: Element | null }>({
    ask: null,
    opener: null,
  });
  if (asked.ask !== ask) setAsked({ ask, opener: document.activeElement });
  const terminal = ask === null ? undefined : terminals.find((entry) => entry.address === ask.address);
  const live = terminal?.state === "live";
  // A session that stops meanwhile needs no answer, except that a question whose action is still running stays up until
  // it settles, and one whose action failed stays up to say why, even if the session left the list (a reconnect lists
  // live terminals only), so the user can try again.
  const keep = busy || error !== null;
  const current = terminal === undefined ? null : terminalTitle(terminal);
  const [lastTitle, setLastTitle] = useState("");
  useEffect(() => {
    if (current !== null) setLastTitle(current);
  }, [current]);
  useEffect(() => {
    if (ask === null || keep || live) return;
    if (ask.kind === "close") onKeep(ask.address);
    onDone();
  }, [ask, keep, live, onDone, onKeep]);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [ask]);
  if (ask === null || !(live || keep)) return null;
  const title = current ?? lastTitle;
  const run = (work: () => Promise<void>, after: () => void): void => {
    setBusy(true);
    work().then(
      () => after(),
      (cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };
  const end = (): void => run(() => endSession(sessionCalls(connection), ask.address), onDone);
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
  // Asked with focus on the page body (a terminal whose renderer had not started yet), or from an element that is gone
  // by now, the question gives focus to the focused pane's terminal instead of leaving keys with nowhere to go.
  const { opener } = asked;
  const backTo = (): HTMLElement | true =>
    opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? true : (terminalInput() ?? true);
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
            End session
          </Button>
          {ask.kind === "close" ? (
            <Button
              variant="primary"
              onClick={() => {
                onKeep(ask.address);
                onDone();
              }}
            >
              Keep running
            </Button>
          ) : null}
        </>
      }
    >
      {error === null ? undefined : (
        <Notice tone="error" title="The session did not end">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
