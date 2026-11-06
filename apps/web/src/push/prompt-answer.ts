import type { PushHostLine } from "@doriface/protocol";
import { useSyncExternalStore } from "react";

/**
 * An answer the page sends for a notice's Allow or one of its prompt's rows, in #192's banner states. `waiting`: the page is not on
 * screen yet, so nothing is sent; `sending`: the host is checking the prompt is still on the live screen;
 * `answered`: the agent got its key; `stale`: the prompt was answered or changed, so nothing was sent; `failed`: the
 * answer did not go through (the host could not be reached, or its link dropped), so nothing was sent; `unknown`: the
 * key press failed after it was sent, so it may have reached the agent.
 */
export type AnswerPhase = "waiting" | "sending" | "answered" | "stale" | "failed" | "unknown";

export interface PromptAnswerState {
  readonly terminal: string;
  readonly phase: AnswerPhase;
}

let state: PromptAnswerState | null = null;
const listeners = new Set<() => void>();
function set(next: PromptAnswerState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export const dismissPromptAnswer = (): void => set(null);

export const usePromptAnswer = (): PromptAnswerState | null =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );

/** The part of `document` that says whether the page is on screen. */
export interface Visibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Resolves once the page is visible: an answer is sent by a person looking at the app, never by a hidden page. */
export function whenVisible(doc: Visibility): Promise<void> {
  if (doc.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const seen = (): void => {
      if (doc.visibilityState !== "visible") return;
      doc.removeEventListener("visibilitychange", seen);
      resolve();
    };
    doc.addEventListener("visibilitychange", seen);
  });
}

/**
 * Sends a notice's answer (Allow, or one of its prompt's rows) from the page: once it is visible, the host checks the
 * prompt against the live screen (`answerApproval`, the rule #192's banner uses) and types the agent's key only if it is
 * unchanged.
 */
export async function answerFromPage(
  terminal: string,
  send: () => Promise<PushHostLine>,
  visible: () => Promise<void>,
): Promise<AnswerPhase> {
  set({ terminal, phase: "waiting" });
  await visible();
  set({ terminal, phase: "sending" });
  let phase: AnswerPhase;
  try {
    const reply = await send();
    phase = reply.t === "answered" || reply.t === "stale" || reply.t === "unknown" ? reply.t : "failed";
  } catch {
    phase = "failed";
  }
  set({ terminal, phase });
  return phase;
}
