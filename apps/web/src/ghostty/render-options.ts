import { single, type TerminalConfig } from "./config.ts";

export interface RendererOptions {
  /** wterm's cursorBlink: undefined follows what programs ask for. */
  readonly cursorBlink: boolean | undefined;
  /** DECSCUSR written into the local terminal as its default cursor. */
  readonly cursorSequence: string;
  readonly hollowCursor: boolean;
  /** Scrollback for new terminals in bytes, as the core's max_scrollback_bytes takes it. */
  readonly scrollbackBytes: number;
  readonly copyOnSelect: boolean;
  readonly hideMouseWhileTyping: boolean;
  readonly pasteProtection: boolean;
  /** Copied text loses its line-end spaces and trailing blank rows (Ghostty's clipboard-trim-trailing-spaces). */
  readonly trimCopy: boolean;
}

const SHAPES: Readonly<Record<string, readonly [blinking: number, steady: number]>> = {
  block: [1, 2],
  block_hollow: [1, 2],
  underline: [3, 4],
  bar: [5, 6],
};

export function rendererOptions(config: TerminalConfig): RendererOptions {
  const blink = single(config, "cursor-style-blink");
  const style = single(config, "cursor-style");
  const [blinking, steady] = SHAPES[style] ?? [1, 2];
  const copyOnSelect = single(config, "copy-on-select");
  return {
    cursorBlink: blink === "" ? undefined : blink === "true",
    cursorSequence: `\u001b[${blink === "false" ? steady : blinking} q`,
    hollowCursor: style === "block_hollow",
    scrollbackBytes: Number(single(config, "scrollback-limit")),
    copyOnSelect: copyOnSelect === "true" || copyOnSelect === "clipboard",
    hideMouseWhileTyping: single(config, "mouse-hide-while-typing") === "true",
    pasteProtection: single(config, "clipboard-paste-protection") === "true",
    trimCopy: single(config, "clipboard-trim-trailing-spaces") !== "false",
  };
}
