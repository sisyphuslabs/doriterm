import { actionFor, actionFromGhostty, decodeZigString } from "./actions.ts";
import { defaultKeymap, type Keymap } from "./defaults.ts";
import { normalizeTrigger, triggerKeys, type Platform } from "./trigger.ts";

/** Only what the user changed: a trigger bound to an action, or null for a default the user removed. */
export type Overrides = ReadonlyMap<string, string | null>;

export const NO_OVERRIDES: Overrides = new Map();

/** Defaults are resolved at read time; a test can pass a different default set. */
export function resolveKeymap(
  platform: Platform,
  overrides: Overrides,
  defaults: Keymap = defaultKeymap(platform),
): Keymap {
  const map = new Map(defaults);
  for (const [trigger, action] of overrides) {
    if (action === null) map.delete(trigger);
    else map.set(trigger, action);
  }
  return map;
}

export function triggersFor(keymap: Keymap, action: string): string[] {
  return [...keymap].filter(([, bound]) => bound === action).map(([trigger]) => trigger);
}

/** The key chips of an action's first binding on this platform, or undefined when nothing is bound to it. */
export function actionKeys(keymap: Keymap, action: string, platform: Platform): string[] | undefined {
  const [trigger] = triggersFor(keymap, action);
  return trigger === undefined ? undefined : triggerKeys(trigger, platform);
}

export type Checked = { readonly ok: true; readonly trigger: string } | { readonly ok: false; readonly reason: string };

/** A write is refused unless the trigger parses and the action exists; the normalized trigger is returned. */
export function checkBinding(trigger: string, action: string | null): Checked {
  const normalized = normalizeTrigger(trigger);
  if (normalized === null) return { ok: false, reason: `"${trigger}" is not a key combination` };
  if (action !== null && actionFor(action) === null) return { ok: false, reason: `"${action}" is not an action` };
  return { ok: true, trigger: normalized };
}

export function withBinding(platform: Platform, overrides: Overrides, trigger: string, action: string): Overrides {
  const next = new Map(overrides);
  const defaults = defaultKeymap(platform);
  if (defaults.get(trigger) === action) next.delete(trigger);
  else next.set(trigger, action);
  return next;
}

export function withoutTrigger(platform: Platform, overrides: Overrides, trigger: string): Overrides {
  const next = new Map(overrides);
  if (defaultKeymap(platform).has(trigger)) next.set(trigger, null);
  else next.delete(trigger);
  return next;
}

/** An override touches an action when it binds a trigger to it or moves one of its default triggers away. */
function touches(platform: Platform, trigger: string, bound: string | null, action: string): boolean {
  return bound === action || defaultKeymap(platform).get(trigger) === action;
}

export function isChanged(platform: Platform, overrides: Overrides, action: string): boolean {
  return [...overrides].some(([trigger, bound]) => touches(platform, trigger, bound, action));
}

/** Forgets every override that touches the action, so its defaults come back. */
export function resetAction(platform: Platform, overrides: Overrides, action: string): Overrides {
  const next = new Map(overrides);
  for (const [trigger, bound] of overrides) if (touches(platform, trigger, bound, action)) next.delete(trigger);
  return next;
}

export interface KeybindLine {
  readonly line: number;
  readonly text: string;
  readonly status: "applies" | "invalid" | "unknown";
  readonly reason?: string;
}

export interface ParsedKeybinds {
  readonly lines: readonly KeybindLine[];
  /** True when the file had `keybind = clear`: every default is dropped before its own lines apply. */
  readonly clear: boolean;
  readonly overrides: Overrides;
}

/** `keybind = trigger=action` lines from a Ghostty config; `unbind` removes, `clear` resets everything. */
export function parseKeybinds(text: string): ParsedKeybinds {
  const lines: KeybindLine[] = [];
  const overrides = new Map<string, string | null>();
  let clear = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    const match = /^keybind\s*=\s*(.*)$/.exec(trimmed);
    if (match === null) return;
    const body = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (body === "clear") {
      clear = true;
      overrides.clear();
      lines.push({ line, text: body, status: "applies" });
      return;
    }
    const eq = body.indexOf("=", body.startsWith("+") ? 1 : 0);
    const split = body.endsWith("+=") ? -1 : eq;
    const [trigger, ghostty] = split === -1 ? [body, ""] : [body.slice(0, split), body.slice(split + 1)];
    const name = ghostty.trim();
    if (name.startsWith("text:") && decodeZigString(name.slice(5)) === null) {
      lines.push({ line, text: body, status: "invalid", reason: "the text has an escape Ghostty does not define" });
      return;
    }
    const action = actionFromGhostty(name);
    if (action === undefined) {
      lines.push({ line, text: body, status: "unknown", reason: `"${ghostty.trim()}" is not an action Doriterm has` });
      return;
    }
    const checked = checkBinding(trigger.replace(/^(global|all|unconsumed|performable):/, ""), action);
    if (!checked.ok) {
      lines.push({ line, text: body, status: "invalid", reason: checked.reason });
      return;
    }
    overrides.set(checked.trigger, action);
    lines.push({ line, text: body, status: "applies" });
  });
  return { lines, clear, overrides };
}

/** The overrides after importing: a clear removes every default first, then the file's lines apply. */
export function importKeybinds(platform: Platform, current: Overrides, parsed: ParsedKeybinds): Overrides {
  const base = parsed.clear
    ? new Map([...defaultKeymap(platform).keys()].map((trigger) => [trigger, null] as const))
    : current;
  return new Map([...base, ...parsed.overrides]);
}

/** A trigger ending in the "=" key is written with Ghostty's "equal" name so the line has one separator. */
const ghosttyTrigger = (trigger: string): string => trigger.replace(/(^|\+)=$/, "$1equal");

export function serializeKeybinds(overrides: Overrides): string {
  const out = ["# Keybindings exported from Doriterm (Ghostty keybind syntax)"];
  for (const [trigger, action] of overrides) {
    const ghostty = action === null ? "unbind" : actionFor(action)?.ghostty;
    const line = `keybind = ${ghosttyTrigger(trigger)}=${ghostty ?? action}`;
    out.push(ghostty === undefined ? `# ${line} (no Ghostty equivalent)` : line);
  }
  return `${out.join("\n")}\n`;
}
