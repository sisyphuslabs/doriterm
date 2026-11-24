/**
 * Which renderer draws terminals: the DOM (the default) or WebGL2, which `@wterm/dom` falls back from to the DOM by
 * itself when WebGL2 is unavailable. Chosen at build time for now, so the render bench can compare the two builds
 * (#2810); the runtime choice replaces this once the numbers decide it.
 */
export type TerminalRenderer = "dom" | "webgl";

export const terminalRenderer = (value: string | undefined): TerminalRenderer => (value === "webgl" ? "webgl" : "dom");

export const TERMINAL_RENDERER: TerminalRenderer = terminalRenderer(import.meta.env["VITE_TERMINAL_RENDERER"]);
