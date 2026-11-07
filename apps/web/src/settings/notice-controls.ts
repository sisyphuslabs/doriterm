import type { PushView } from "../push/push-settings.ts";

export type NoticeAction = "check-again" | "turn-off" | "turn-on";

/** What Settings > Notifications lets the reader do in one state: its buttons, and whether the rest can be changed. */
export interface NoticeControls {
  readonly actions: readonly NoticeAction[];
  /** Turn on is shown but cannot be pressed. */
  readonly turnOnDisabled: boolean;
  /** Send test, the event switches and the machine switches. */
  readonly editable: boolean;
}

export function noticeControls(view: Pick<PushView, "on" | "busy" | "permission">, desktop: boolean): NoticeControls {
  const blocked = view.permission === "denied";
  const editable = view.on && !view.busy;
  // Nothing can be shown while the OS refuses: the remedy, and a way to turn them off, are all that is left to do.
  if (desktop && blocked) {
    return { actions: view.on ? ["check-again", "turn-off"] : ["check-again"], turnOnDisabled: false, editable: false };
  }
  if (view.on) return { actions: ["turn-off"], turnOnDisabled: false, editable };
  return { actions: ["turn-on"], turnOnDisabled: view.busy || blocked, editable };
}
