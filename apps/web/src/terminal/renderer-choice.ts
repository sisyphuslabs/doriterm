/**
 * Which renderer draws terminals: the DOM (the default) or WebGL2, chosen at build time so the render bench can compare
 * the two builds (#2810, docs/render-bench.md). WebGL2 draws heavy output faster on a GPU, but @wterm 0.5.9 and 0.6.0
 * draw Hangul narrower than its cells and lose the bottom of a phone's view after a full redraw, so the DOM stays.
 */
export type TerminalRenderer = "dom" | "webgl";

export const terminalRenderer = (value: string | undefined): TerminalRenderer => (value === "webgl" ? "webgl" : "dom");

export const TERMINAL_RENDERER: TerminalRenderer = terminalRenderer(import.meta.env["VITE_TERMINAL_RENDERER"]);
