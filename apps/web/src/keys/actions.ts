export type Scope = "app" | "terminal";

export interface ActionDef {
  /** Our id, herdr-app style: `tab.new`, `pane.go:left`, `send:<text>`. */
  readonly id: string;
  readonly scope: Scope;
  readonly label: string;
  /** Ghostty's name for the same action, used by keybind import and export. */
  readonly ghostty?: string;
}

const app = (id: string, label: string, ghostty?: string): ActionDef =>
  ghostty === undefined ? { id, scope: "app", label } : { id, scope: "app", label, ghostty };
const term = (id: string, label: string, ghostty?: string): ActionDef =>
  ghostty === undefined ? { id, scope: "terminal", label } : { id, scope: "terminal", label, ghostty };

/** New tab, read directly where a surface shows its label (the phone header button). */
export const NEW_TAB: ActionDef = app("tab.new", "New tab", "new_tab");

export const ACTIONS: readonly ActionDef[] = [
  NEW_TAB,
  app("tab.close", "Close tab", "close_tab"),
  app("tab.next", "Next tab", "next_tab"),
  app("tab.prev", "Previous tab", "previous_tab"),
  ...Array.from({ length: 9 }, (_, index) =>
    app(`tab.select:${index + 1}`, `Go to tab ${index + 1}`, `goto_tab:${index + 1}`),
  ),
  app("tab.last", "Go to last tab", "last_tab"),
  app("tab.rename", "Rename tab…"),
  app("tab.move:left", "Move tab left", "move_tab:-1"),
  app("tab.move:right", "Move tab right", "move_tab:1"),
  app("pane.split:right", "Split right", "new_split:right"),
  app("pane.split:down", "Split down", "new_split:down"),
  app("pane.close", "Close pane", "close_surface"),
  app("pane.go:left", "Focus pane left", "goto_split:left"),
  app("pane.go:right", "Focus pane right", "goto_split:right"),
  app("pane.go:up", "Focus pane up", "goto_split:up"),
  app("pane.go:down", "Focus pane down", "goto_split:down"),
  app("pane.swap:left", "Swap pane left"),
  app("pane.swap:right", "Swap pane right"),
  app("pane.swap:up", "Swap pane up"),
  app("pane.swap:down", "Swap pane down"),
  app("pane.resize:left", "Move the pane's edge left", "resize_split:left,10"),
  app("pane.resize:right", "Move the pane's edge right", "resize_split:right,10"),
  app("pane.resize:up", "Move the pane's edge up", "resize_split:up,10"),
  app("pane.resize:down", "Move the pane's edge down", "resize_split:down,10"),
  app("pane.equalize", "Equalize panes", "equalize_splits"),
  app("pane.zoom", "Zoom pane", "toggle_split_zoom"),
  app("agent.next", "Next agent"),
  app("agent.prev", "Previous agent"),
  app("layout.toggle:sidebar", "Show or hide the sidebar"),
  app("layout.focus:sidebar", "Move focus between the terminal and the sidebar"),
  app("session.rename", "Rename session…"),
  app("session.end", "End session…"),
  app("space.rename", "Rename space…"),
  // herdr-app's space chords: a number chord selects a space and the bracket pair cycles through them. A focused terminal
  // program keeps the number chords (terminal-keeps.ts), which are Ctrl and a digit, its own control keys.
  ...Array.from({ length: 9 }, (_, index) => app(`space.select:${index + 1}`, `Go to space ${index + 1}`)),
  app("space.next", "Next space"),
  app("space.prev", "Previous space"),
  // No default chord (#194): any free one would collide with a terminal program; it is bound in Settings > Keybindings.
  app("voice.dictate", "Dictate"),
  app("app.palette", "Command palette", "toggle_command_palette"),
  app("app.settings", "Open settings", "open_config"),
  app("app.zoom_in", "Larger terminal text", "increase_font_size:1"),
  app("app.zoom_out", "Smaller terminal text", "decrease_font_size:1"),
  app("app.zoom_reset", "Reset terminal text size", "reset_font_size"),
  term("terminal.copy", "Copy", "copy_to_clipboard"),
  term("terminal.paste", "Paste", "paste_from_clipboard"),
  // herdr-app's terminal.paste_image, unbound here (#701): Ctrl+V keeps its own handling unless bound to it.
  term("terminal.paste_image", "Paste image"),
  term("terminal.select_all", "Select all", "select_all"),
  term("terminal.clear", "Clear screen", "clear_screen"),
  term("terminal.scroll:top", "Scroll to top", "scroll_to_top"),
  term("terminal.scroll:bottom", "Scroll to bottom", "scroll_to_bottom"),
  term("terminal.scroll:page_up", "Scroll a page up", "scroll_page_up"),
  term("terminal.scroll:page_down", "Scroll a page down", "scroll_page_down"),
  term("terminal.scroll:line_up", "Scroll a line up", "scroll_page_lines:-1"),
  term("terminal.scroll:line_down", "Scroll a line down", "scroll_page_lines:1"),
  term("terminal.prompt:prev", "Previous prompt", "jump_to_prompt:-1"),
  term("terminal.prompt:next", "Next prompt", "jump_to_prompt:1"),
];

export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((def) => [def.id, def]));
const ACTION_BY_GHOSTTY: ReadonlyMap<string, ActionDef> = new Map(
  ACTIONS.flatMap((def) => (def.ghostty === undefined ? [] : [[def.ghostty, def] as const])),
);

const SEND_LABEL: Readonly<Record<string, string>> = {
  "\u0001": "Send ^A (line start)",
  "\u0005": "Send ^E (line end)",
  "\u0015": "Send ^U (delete to line start)",
  "\u0017": "Send ^W (delete word)",
  "\u001bb": "Send Esc b (word left)",
  "\u001bf": "Send Esc f (word right)",
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const hex = (byte: number): string => `\\x${byte.toString(16).padStart(2, "0")}`;

/** The length a UTF-8 lead byte announces, or 0 when it cannot start a sequence. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  return lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
}

/** A byte payload for display: valid UTF-8 as text, every other byte and ASCII controls as \xNN. */
export function displayBytes(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    const length = sequenceLength(lead);
    let text: string | null = null;
    if (length > 0 && index + length <= bytes.length) {
      try {
        text = strictUtf8.decode(bytes.subarray(index, index + length));
      } catch {
        text = null;
      }
    }
    if (text === null || lead < 0x20 || lead === 0x7f) {
      out += hex(lead);
      index += 1;
    } else {
      out += text;
      index += length;
    }
  }
  return out;
}

/** An action id as text a person can read: a send: payload shows its control bytes as \xNN. */
export function displayActionId(id: string): string {
  return id.startsWith("send:") ? `send:${displayBytes(sendBytes(id))}` : id;
}

/** The action for an id, including `send:<text>` which is any text written to the terminal. */
export function actionFor(id: string): ActionDef | null {
  const known = ACTION_BY_ID.get(id);
  if (known !== undefined) return known;
  if (!id.startsWith("send:")) return null;
  const text = id.slice(5);
  return {
    id,
    scope: "terminal",
    label: SEND_LABEL[text] ?? `Send "${displayBytes(sendBytes(id))}"`,
    ghostty: `text:${escapeGhostty(text)}`,
  };
}

function escapeGhostty(text: string): string {
  return [...text]
    .map((c) => {
      if (c === "\\") return "\\\\";
      const code = c.charCodeAt(0);
      return code < 0x20 || code >= 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
    })
    .join("");
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
const utf8 = (text: string): string => latin1(new TextEncoder().encode(text));

/**
 * Decodes Ghostty's text: payload, which uses Zig string escapes, into a byte string (one char per
 * byte): \xNN is one raw byte, literal text and \u{N...} are UTF-8. Null when an escape is not Zig's,
 * including a surrogate or a code point past U+10FFFF.
 */
export function decodeZigString(text: string): string | null {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char !== "\\") {
      const point = text.codePointAt(index) ?? 0;
      const literal = String.fromCodePoint(point);
      out += utf8(literal);
      index += literal.length;
      continue;
    }
    const next = text[index + 1] ?? "";
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      index += 2;
    } else if (next === "x" && /^[0-9a-f]{2}$/i.test(text.slice(index + 2, index + 4))) {
      out += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16));
      index += 4;
    } else if (next === "u") {
      const match = /^\{([0-9a-f]+)\}/i.exec(text.slice(index + 2));
      const code = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 16);
      if (match === null || !(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += utf8(String.fromCodePoint(code));
      index += 2 + match[0].length;
    } else {
      return null;
    }
  }
  return out;
}

/** The bytes a send:<payload> action writes: the payload is a byte string, one char per byte. */
export function sendBytes(id: string): Uint8Array {
  return Uint8Array.from(id.slice("send:".length), (char) => char.charCodeAt(0) & 0xff);
}

/** Our id for a Ghostty action name; `text:` becomes `send:`, `unbind` is null, unknown is undefined. */
export function actionFromGhostty(name: string): string | null | undefined {
  if (name === "unbind") return null;
  if (name.startsWith("text:")) {
    const decoded = decodeZigString(name.slice(5));
    return decoded === null ? undefined : `send:${decoded}`;
  }
  return ACTION_BY_GHOSTTY.get(name)?.id;
}
