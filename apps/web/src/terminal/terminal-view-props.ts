import type { HcConnection } from "@doriface/client";
import type { TerminalEnd } from "./terminal-end.ts";
import type { TerminalPort } from "./terminal-port.ts";

/** Typed text, or the bytes a bound key sends. */
export type TerminalInput = string | Uint8Array;

export interface TerminalViewProps {
  readonly connection: HcConnection;
  readonly address: string;
  /** The program this view was opened for; views are keyed by it, so a restarted program gets a new view. */
  readonly pid: number | null;
  /** Whether the core lists the terminal as live; a view waiting for a restart ends when it stops being live. */
  readonly live: boolean;
  readonly focused: boolean;
  /**
   * This page asked for this terminal's pane (opened, split, picked it): starting, it takes the keyboard from wherever
   * it is. Unset where no other device edits what is shown (the phone shows one terminal at a time). Not asked for (a
   * view another device's layout edit mounts again, #332), it takes the keyboard only from nowhere.
   */
  readonly claimed?: boolean;
  /**
   * Whether a focus here raises a soft keyboard, which only a press may ask for: on a phone the keyboard would come up
   * over the output as the view starts, so the view takes no focus of its own and the keys bar's button asks for it
   * (#1375). Unset, as on a desktop or a narrow window driven by a mouse, the view takes the focus as it starts.
   */
  readonly softKeyboard?: boolean;
  readonly label: string;
  readonly className?: string;
  /** Rewrites typed input before it is sent (latched phone modifiers); an empty result sends nothing. */
  readonly transformInput?: (data: string) => string;
  /**
   * A composition is typed as it starts instead of when the input method ends it, through `transformInput`: set while a
   * phone modifier is latched, so ctrl and a Korean keyboard's ㅊ is ^C at once rather than waiting for the next jamo.
   */
  readonly typesComposition?: boolean;
  /**
   * The terminal is browsed read-only (browse-mode.ts): touches and clicks reach neither the program nor its input, no
   * soft keyboard comes up, and a held finger's menu offers Copy alone.
   */
  readonly browsing?: boolean;
  /** False while the terminal's machine is offline: a view not attached yet waits to attach until it is back (#2003). */
  readonly reachable?: boolean;
  /** The view's port for keys pressed outside it (the phone's keys bar); null once it unmounts. */
  readonly onPort?: (port: TerminalPort | null) => void;
  /** Every time the stream ends, with why; see TerminalEnd. */
  readonly onEnd?: (address: string, end: TerminalEnd) => void;
  /** The action of a view whose program had ended before it attached, which reports it `finished` (default Close tab). */
  readonly closeLabel?: string;
  /** Once the view shows that its program had ended before it attached: there is no terminal left to type into. */
  readonly onEnded?: () => void;
  /** A CSS length the jump-to-bottom button keeps above the terminal's bottom, for controls floating over it. */
  readonly jumpClearance?: string;
}
