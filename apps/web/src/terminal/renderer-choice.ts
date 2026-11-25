/**
 * Which renderer draws terminals: WebGL2 (the default, #2810), which `@wterm/dom` falls back from to the DOM by itself
 * when WebGL2 is unavailable or its context is lost, or the DOM for a build made with `VITE_TERMINAL_RENDERER=dom`, so
 * the render bench can still compare the two (docs/render-bench.md).
 */
export type TerminalRenderer = "dom" | "webgl";

export const terminalRenderer = (value: string | undefined): TerminalRenderer => (value === "dom" ? "dom" : "webgl");

export const TERMINAL_RENDERER: TerminalRenderer = terminalRenderer(import.meta.env["VITE_TERMINAL_RENDERER"]);
