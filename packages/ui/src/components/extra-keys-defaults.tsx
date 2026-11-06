import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ExtraKey } from "./extra-keys-bar.tsx";

/**
 * The row a caller that names no keys draws: the modifiers and editing keys, the arrows, then the characters a phone
 * keyboard makes awkward. `cmd` is left out on purpose - only a Mac host draws Command, and a Mac caller passes its
 * own row. A fresh phone passes its catalogue's `DEFAULT_KEY_IDS` instead, which orders Alt fifth.
 */
export const DEFAULT_EXTRA_KEYS: readonly ExtraKey[] = [
  { id: "ctrl", label: "ctrl", name: "Control", modifier: true },
  { id: "shift", label: "shift", name: "Shift", modifier: true },
  { id: "tab", label: "tab", name: "Tab" },
  { id: "esc", label: "esc", name: "Escape" },
  { id: "interrupt", label: "^C", name: "Control C" },
  { id: "left", label: <ArrowLeft aria-hidden />, name: "Arrow left" },
  { id: "up", label: <ArrowUp aria-hidden />, name: "Arrow up" },
  { id: "down", label: <ArrowDown aria-hidden />, name: "Arrow down" },
  { id: "right", label: <ArrowRight aria-hidden />, name: "Arrow right" },
  { id: "alt", label: "alt", name: "Option", modifier: true },
  { id: "tilde", label: "~", name: "Tilde" },
  { id: "pipe", label: "|", name: "Vertical bar" },
  { id: "slash", label: "/", name: "Slash" },
  { id: "dash", label: "-", name: "Hyphen" },
];
