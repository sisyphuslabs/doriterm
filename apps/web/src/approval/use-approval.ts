import type { HcConnection } from "@doriface/client";
import {
  answerApproval,
  approvalKey,
  CLAIM_TTL_MS,
  type ApprovalCore,
  type ApprovalMark,
  type PromptReply,
  readApproval,
  readApprovalRecord,
  waitsOnApproval,
} from "@doriface/protocol";
import type { ApprovalBannerState } from "@doriface/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../workspace/model.ts";
import { approvalCore } from "./approval-core.ts";
import { showsPrompt, stateAfterAnswer, stateAfterPrompt } from "./approval-view.ts";
import { thisAnswerer } from "./answerer.ts";
import { cardState, pause, readCard, readKeyOf } from "./card-read.ts";
import type { CardState } from "./waiting-keys.ts";

export interface ApprovalView {
  readonly mark: ApprovalMark;
  readonly state: ApprovalBannerState;
  /** While another answer holds the prompt: when its claim lapses on this client's clock and this one may answer. */
  readonly retryAtMs?: number;
  /** After this client's own answer failed: its claim's attempt id, so Try again may take over exactly that claim. */
  readonly retake?: string;
}

export interface Approval extends ApprovalView {
  readonly answer: (choice: PromptReply) => void;
  readonly dismiss: () => void;
}

const ANSWERED_MS = 4000;
/** How long the card watches for the next step of several after an answer; two reads in a row must agree on it. */
const NEXT_STEP_WAITS_MS = [100, 150, 300, 600, 1200];

/**
 * The step after one just answered, when the agent asks several questions in one turn: the same turn and status, a new
 * dialog on the live screen. Nothing when the screen moves on to anything else.
 */
async function readNextStep(
  core: ApprovalCore,
  answered: ApprovalMark,
  signal: AbortSignal,
  waits: readonly number[] = NEXT_STEP_WAITS_MS,
  seen?: ApprovalMark,
): Promise<ApprovalMark | undefined> {
  const [wait, ...later] = waits;
  if (wait === undefined || signal.aborted) return undefined;
  await pause(wait, signal);
  const now = await readApproval(core, answered.terminal);
  const next = now !== undefined && now.turn === answered.turn && approvalKey(now) !== approvalKey(answered);
  // The answer's keys may still be landing (boxes toggled, → not yet): a step counts once two reads agree on it.
  if (next && seen !== undefined && approvalKey(seen) === approvalKey(now)) return now;
  return readNextStep(core, answered, signal, later, next ? now : undefined);
}

/**
 * The prompt a terminal's agent waits on (a permission, a question, a plan), as a card: found from the agent's status (`blocked`,
 * `kind: permission`) plus its live screen, answered once across every client, and resolved when the agent moves on.
 * `card` says whether one is up, still being read for, or not coming, so the keys strip can stand in where none is.
 */
export function useApproval(
  connection: HcConnection,
  terminal: Session,
): { readonly approval: Approval | undefined; readonly card: CardState } {
  const core = useMemo(() => approvalCore(connection), [connection]);
  const [view, setView] = useState<ApprovalView | undefined>(undefined);
  const current = useRef(view);
  current.current = view;
  const waiting = waitsOnApproval(terminal);
  // The screen read for this wait (its address and turn) that has finished, found a dialog or not.
  const readKey = readKeyOf(terminal);
  const [read, setRead] = useState<string | undefined>(undefined);

  useEffect(() => {
    const shown = current.current;
    if (!waiting || (shown !== undefined && showsPrompt(shown.mark, terminal))) return;
    const abort = new AbortController();
    void readCard(core, terminal.address, abort.signal, {
      drawn: (mark) => setView({ mark, state: { kind: "waiting" } }),
      finished: () => setRead(readKey),
    });
    return () => abort.abort();
  }, [core, terminal.address, waiting, terminal.turn, readKey]);

  useEffect(() => {
    const shown = current.current;
    const open = shown !== undefined && ["waiting", "failed", "elsewhere", "unknown"].includes(shown.state.kind);
    if (shown === undefined || !open || showsPrompt(shown.mark, terminal)) return;
    let live = true;
    const resolve = async () => {
      // A failed read means no attribution to show: the banner goes, as if it had been answered in the terminal.
      const record = await readApprovalRecord(core, shown.mark).catch(() => undefined);
      if (!live || current.current?.mark !== shown.mark) return;
      const state = stateAfterPrompt(record, thisAnswerer());
      setView(state === undefined ? undefined : { mark: shown.mark, state });
    };
    void resolve();
    return () => {
      live = false;
    };
  }, [core, terminal]);

  useEffect(() => {
    if (view?.state.kind !== "elsewhere" || view.retryAtMs === undefined) return;
    const back = { mark: view.mark, state: { kind: "waiting" } } as const;
    const timer = setTimeout(
      () => setView((now) => (now === view ? back : now)),
      Math.max(0, view.retryAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view?.state.kind !== "answered") return;
    const timer = setTimeout(() => setView((now) => (now === view ? undefined : now)), ANSWERED_MS);
    return () => clearTimeout(timer);
  }, [view]);

  if (view === undefined) return { approval: undefined, card: cardState(terminal, false, read) };
  const approval: Approval = {
    ...view,
    answer: (choice) => {
      if (view.state.kind !== "waiting" && view.state.kind !== "failed") return;
      const { mark, retake } = view;
      setView({ mark, state: { kind: "sending", choice } });
      const self = thisAnswerer();
      const send = async () => {
        try {
          const result = await answerApproval(
            core,
            mark,
            choice,
            self,
            Date.now(),
            retake === undefined ? {} : { retake },
          );
          const state = stateAfterAnswer(result, mark, choice, self);
          // Another answer's claim lapses after CLAIM_TTL_MS of this client's own watch, which starts now; the claimer's
          // own clock (its `atMs`) is never compared with this one.
          const retryAtMs = state.kind === "elsewhere" ? Date.now() + CLAIM_TTL_MS : undefined;
          if (result.kind === "failed") setView({ mark, state, retake: result.attempt });
          else setView(retryAtMs === undefined ? { mark, state } : { mark, state, retryAtMs });
          if (result.kind !== "sent") return;
          const next = await readNextStep(core, mark, new AbortController().signal).catch(() => undefined);
          if (next !== undefined)
            setView((now) => (now?.mark === mark ? { mark: next, state: { kind: "waiting" } } : now));
        } catch {
          // The claim itself did not get through (a dropped connection): nothing was sent; offer it again.
          setView({ mark, state: { kind: "failed", choice } });
        }
      };
      void send();
    },
    dismiss: () => setView(undefined),
  };
  return { approval, card: cardState(terminal, true, read) };
}
