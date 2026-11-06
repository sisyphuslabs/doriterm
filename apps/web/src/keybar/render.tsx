import type { ExtraKey } from "@doriface/ui";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { BarIcon } from "./catalog.ts";
import type { BarEntry } from "./entries.ts";

const GLYPHS: Readonly<Record<BarIcon, typeof ArrowLeft>> = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown,
};

/** One resolved entry as the bar primitive draws it: an icon label where the key has a glyph, and the modifier flag. */
export function toExtra(entry: BarEntry): ExtraKey {
  const Glyph = entry.icon === null ? null : GLYPHS[entry.icon];
  const label = Glyph === null ? entry.label : <Glyph aria-hidden />;
  return entry.bytes === null
    ? { id: entry.id, label, name: entry.name, modifier: true }
    : { id: entry.id, label, name: entry.name };
}
