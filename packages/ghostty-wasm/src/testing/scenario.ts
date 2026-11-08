import { GhosttyCore } from "@wterm/ghostty";
import { readRootProgramStatus } from "./program-status.ts";
import type { ProgramStatus } from "./program-status.ts";

export const SCENARIO_INPUT =
  "hello ghostty\r\n" +
  "\x1b[1;31mbold red\x1b[0m \x1b[38;2;255;128;0mtruecolor\x1b[0m\r\n" +
  "\x1b]7501;state=working:app=doriface:progress=40\x1b\\" +
  "\x1b]7501;?\x1b\\" +
  "after status";

const COLS = 80;
const ROWS = 24;

export type ScenarioResult = {
  readonly lines: readonly string[];
  readonly boldRedFlags: number;
  readonly boldRedRgb: number | null;
  readonly truecolorRgb: number | null;
  readonly response: string | null;
  readonly programStatus: ProgramStatus | null;
  readonly wasmBytes: number;
};

function rowText(core: GhosttyCore, row: number): string {
  let text = "";
  for (let col = 0; col < COLS; col += 1) text += String.fromCodePoint(core.getCell(row, col).char || 32);
  return text.trimEnd();
}

/**
 * Writes `input` into the core. The core writes synchronously, calling back once per chunk before it returns; one that
 * takes nothing (disposed, no terminal, no buffer for the input) returns without calling back, so waiting for that call
 * would wait forever. That fails here at once instead (#1002).
 */
export async function writeAll(core: GhosttyCore, input: string): Promise<void> {
  let chunks = 0;
  core.writeString(input, () => {
    chunks += 1;
  });
  if (chunks === 0) throw new Error("the core wrote nothing: it has no terminal, or no buffer for the input");
}

export async function runScenario(wasmUrl: string): Promise<ScenarioResult> {
  const core = await GhosttyCore.load({ wasmPath: wasmUrl });
  try {
    core.init(COLS, ROWS);
    await writeAll(core, SCENARIO_INPUT);
    const response = await fetch(wasmUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      lines: [rowText(core, 0), rowText(core, 1), rowText(core, 2)],
      boldRedFlags: core.getCell(1, 0).flags,
      boldRedRgb: core.getCell(1, 0).fgRgb ?? null,
      truecolorRgb: core.getCell(1, 9).fgRgb ?? null,
      response: core.getResponse(),
      programStatus: await readRootProgramStatus(bytes, SCENARIO_INPUT),
      wasmBytes: bytes.byteLength,
    };
  } finally {
    core.dispose();
  }
}
