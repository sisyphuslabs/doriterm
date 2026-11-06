/**
 * One key of a pack. Its bytes are fixed rather than looked up, because a pack key is often a chord of several keys
 * (a tmux prefix and its command) that no single built-in key sends.
 */
export interface PackKey {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly bytes: string;
}

/** A set of keys the person adds to the bar as one tab. */
export interface KeyPack {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly keys: readonly PackKey[];
}

/** The person's own pack; its keys come from the settings, not from here. */
export const FAVORITES_PACK_ID = "favorites";

const TMUX_PREFIX = "\u0002";

const NAVIGATION: KeyPack = {
  id: "navigation",
  name: "Navigation",
  description: "Home, End, the pages and Delete, plus the four arrows on any shell",
  keys: [
    { id: "nav-home", label: "home", name: "Home", bytes: "\u001b[H" },
    { id: "nav-end", label: "end", name: "End", bytes: "\u001b[F" },
    { id: "nav-pageup", label: "pgup", name: "Page up", bytes: "\u001b[5~" },
    { id: "nav-pagedown", label: "pgdn", name: "Page down", bytes: "\u001b[6~" },
    { id: "nav-delete", label: "del", name: "Delete", bytes: "\u001b[3~" },
    { id: "nav-left", label: "←", name: "Arrow left", bytes: "\u001b[D" },
    { id: "nav-up", label: "↑", name: "Arrow up", bytes: "\u001b[A" },
    { id: "nav-down", label: "↓", name: "Arrow down", bytes: "\u001b[B" },
    { id: "nav-right", label: "→", name: "Arrow right", bytes: "\u001b[C" },
  ],
};

const CTRL_CHORDS: KeyPack = {
  id: "ctrl-chords",
  name: "Ctrl chords",
  description: "Every control letter, A to Z, one tap each",
  keys: Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(0x61 + index);
    return {
      id: `ctrl-${letter}`,
      label: `^${letter.toUpperCase()}`,
      name: `Control ${letter.toUpperCase()}`,
      bytes: String.fromCharCode(1 + index),
    };
  }),
};

const TMUX: KeyPack = {
  id: "tmux",
  name: "Tmux",
  description: "The prefix and the commands worth one tap",
  keys: [
    { id: "tmux-prefix", label: "^B", name: "Tmux prefix", bytes: TMUX_PREFIX },
    { id: "tmux-new", label: "new", name: "New window", bytes: `${TMUX_PREFIX}c` },
    { id: "tmux-next", label: "next", name: "Next window", bytes: `${TMUX_PREFIX}n` },
    { id: "tmux-previous", label: "prev", name: "Previous window", bytes: `${TMUX_PREFIX}p` },
    { id: "tmux-split", label: "split", name: "Split pane", bytes: `${TMUX_PREFIX}%` },
    { id: "tmux-split-down", label: "below", name: "Split pane below", bytes: `${TMUX_PREFIX}"` },
    { id: "tmux-list", label: "list", name: "List windows", bytes: `${TMUX_PREFIX}w` },
    { id: "tmux-zoom", label: "zoom", name: "Zoom pane", bytes: `${TMUX_PREFIX}z` },
    { id: "tmux-detach", label: "detach", name: "Detach", bytes: `${TMUX_PREFIX}d` },
  ],
};

const AGENT_KEYS: KeyPack = {
  id: "agent",
  name: "Coding agents",
  description: "What a terminal agent's own screen reads: interrupt, modes, approve",
  keys: [
    { id: "agent-escape", label: "esc", name: "Escape", bytes: "\u001b" },
    { id: "agent-shift-tab", label: "⇧tab", name: "Shift Tab", bytes: "\u001b[Z" },
    { id: "agent-interrupt", label: "^C", name: "Control C", bytes: "\u0003" },
    { id: "agent-clear", label: "^L", name: "Control L", bytes: "\u000c" },
    { id: "agent-exit", label: "^D", name: "Control D", bytes: "\u0004" },
    { id: "agent-enter", label: "⏎", name: "Return", bytes: "\r" },
    { id: "agent-yes", label: "y", name: "Yes", bytes: "y" },
    { id: "agent-no", label: "n", name: "No", bytes: "n" },
  ],
};

export const PACKS: readonly KeyPack[] = [NAVIGATION, CTRL_CHORDS, TMUX, AGENT_KEYS];

const BY_ID: ReadonlyMap<string, KeyPack> = new Map(PACKS.map((entry) => [entry.id, entry]));

export function pack(id: string): KeyPack | undefined {
  return BY_ID.get(id);
}

/** Every pack a tab can name, the person's own included. */
export function isPackId(id: string): boolean {
  return id === FAVORITES_PACK_ID || BY_ID.has(id);
}
