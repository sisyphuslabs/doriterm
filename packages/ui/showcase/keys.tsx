import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ExtraKey } from "../src/index.ts";

/** The keys the showcase's phone bar draws, in the order the product's own row starts with. */
export const DEMO_KEYS: readonly ExtraKey[] = [
  { id: "ctrl", label: "ctrl", name: "Control", modifier: true },
  { id: "shift", label: "shift", name: "Shift", modifier: true },
  { id: "tab", label: "tab", name: "Tab" },
  { id: "esc", label: "esc", name: "Escape" },
  { id: "interrupt", label: "^C", name: "Control C" },
  { id: "left", label: <ArrowLeft aria-hidden />, name: "Arrow left" },
  { id: "up", label: <ArrowUp aria-hidden />, name: "Arrow up" },
  { id: "down", label: <ArrowDown aria-hidden />, name: "Arrow down" },
  { id: "right", label: <ArrowRight aria-hidden />, name: "Arrow right" },
  { id: "tilde", label: "~", name: "Tilde" },
  { id: "pipe", label: "|", name: "Vertical bar" },
  { id: "slash", label: "/", name: "Slash" },
  { id: "dash", label: "-", name: "Hyphen" },
];
