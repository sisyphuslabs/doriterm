import { KEY_BY_NAME } from "./keys.ts";
import type { TerminalConfig } from "./config.ts";
import { checkValue } from "./values.ts";

export type LineStatus = "applies" | "new-terminals" | "unsupported" | "invalid" | "unknown";

export interface ParsedLine {
  readonly line: number;
  readonly key: string;
  readonly value: string;
  readonly status: LineStatus;
  /** Why it does not apply, for unsupported, invalid and unknown lines. */
  readonly reason?: string;
}

export interface ParsedConfig {
  readonly lines: readonly ParsedLine[];
  /** Only the keys this text set, ready to merge over the current config. */
  readonly config: TerminalConfig;
}

function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/**
 * Parses a Ghostty config file: `key = value` lines, full-line `#` comments, repeated keys appended
 * (an empty value clears a repeatable list and resets any other key). Unknown and invalid lines are
 * reported and skipped; unsupported keys are kept so an export round-trips them.
 */
export function parseGhosttyConfig(text: string): ParsedConfig {
  const lines: ParsedLine[] = [];
  const config = new Map<string, readonly string[]>();
  const touched = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    const line = index + 1;
    if (eq === -1) {
      lines.push({ line, key: trimmed, value: "", status: "invalid", reason: "expects key = value" });
      return;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    const def = KEY_BY_NAME.get(key);
    if (def === undefined) {
      lines.push({ line, key, value, status: "unknown", reason: "not a terminal setting Doriterm knows" });
      return;
    }
    if (value === "") {
      config.set(key, []);
      touched.add(key);
      lines.push(
        def.support.level === "unsupported"
          ? { line, key, value, status: "unsupported", reason: def.support.reason }
          : {
              line,
              key,
              value,
              status: def.support.level === "live" ? "applies" : "new-terminals",
              reason: "resets to the default",
            },
      );
      return;
    }
    const checked = checkValue(def.kind, value);
    if (!checked.ok) {
      lines.push({ line, key, value, status: "invalid", reason: checked.reason });
      return;
    }
    const previous = touched.has(key) ? (config.get(key) ?? []) : [];
    touched.add(key);
    config.set(key, def.repeatable ? [...previous, value] : [value]);
    const support = def.support;
    lines.push(
      support.level === "unsupported"
        ? { line, key, value, status: "unsupported", reason: support.reason }
        : { line, key, value, status: support.level === "live" ? "applies" : "new-terminals" },
    );
  });
  for (const [key, values] of config) {
    if (values.length === 0) config.delete(key);
  }
  return { lines, config: withResets(config, touched) };
}

/** Keys reset with an empty value stay in the result as "remove this key" markers. */
function withResets(config: Map<string, readonly string[]>, touched: ReadonlySet<string>): TerminalConfig {
  for (const key of touched) if (!config.has(key)) config.set(key, RESET);
  return config;
}

/** Marks a key the parsed text reset; merging removes it. */
export const RESET: readonly string[] = Object.freeze([]);

/** Applies parsed keys over the current config: set keys replace, reset keys return to the default. */
export function mergeConfig(current: TerminalConfig, parsed: TerminalConfig): TerminalConfig {
  const next = new Map(current);
  for (const [key, values] of parsed) {
    if (values === RESET) next.delete(key);
    else next.set(key, values);
  }
  return next;
}
