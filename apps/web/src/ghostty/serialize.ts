import { KEYS } from "./keys.ts";
import type { TerminalConfig } from "./config.ts";

const quote = (value: string): string =>
  /^\s|\s$|["\\]/.test(value) ? `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"` : value;

/** Writes the non-default keys as a Ghostty config file, in schema order, one line per value. */
export function serializeGhosttyConfig(config: TerminalConfig): string {
  const lines = ["# Terminal settings exported from Doriterm (Ghostty config syntax)"];
  for (const def of KEYS) {
    const values = config.get(def.key);
    if (values === undefined) continue;
    if (values.length === 0) lines.push(`${def.key} = ""`);
    for (const value of values) lines.push(`${def.key} = ${quote(value)}`);
  }
  return `${lines.join("\n")}\n`;
}
