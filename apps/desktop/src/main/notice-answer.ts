import type { NoticeAnswer } from "../shared/bridge.ts";

/** The part of an Electron Notification a show is judged by: `show()` itself and the `show`/`failed` events it raises. */
export interface Shown {
  once(event: "show", listener: () => void): unknown;
  once(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
}

export type Wait = (ms: number, step: () => void) => () => void;

/** A show that raised neither event within this long is taken as accepted, so a platform that reports no `show` answers. */
export const SETTLE_MS = 3_000;

const timer: Wait = (ms, step) => {
  const handle = setTimeout(step, ms);
  return () => clearTimeout(handle);
};

/** Shows `shown` and resolves with the OS's answer: `failed` or a thrown `show()` is a refusal with its reason. */
export function showAndAnswer(shown: Shown, wait: Wait = timer, settleMs: number = SETTLE_MS): Promise<NoticeAnswer> {
  return new Promise((resolve) => {
    let cancel: (() => void) | null = null;
    let settled = false;
    const settle = (answer: NoticeAnswer): void => {
      if (settled) return;
      settled = true;
      cancel?.();
      resolve(answer);
    };
    shown.once("show", () => settle({ accepted: true }));
    shown.once("failed", (_event, error) => settle({ accepted: false, reason: error }));
    try {
      shown.show();
    } catch (error) {
      settle({ accepted: false, reason: error instanceof Error ? error.message : String(error) });
    }
    if (!settled) cancel = wait(settleMs, () => settle({ accepted: true }));
  });
}
