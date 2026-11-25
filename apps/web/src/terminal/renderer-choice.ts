/**
 * Which renderer draws terminals (#2810): WebGL2 where a GPU draws it, the DOM everywhere else. On a GPU, WebGL halves
 * the main thread's work under heavy output and draws more than twice the bytes a second (docs/render-bench.md). A
 * WebGL2 only a software rasterizer provides (SwiftShader, llvmpipe: no GPU, a blocklisted one, most VMs) costs a core
 * per page and falls behind typed-ahead frames, so those draw with the DOM; `@wterm/dom` also falls back to the DOM by
 * itself when WebGL2 is missing or its context is lost. `VITE_TERMINAL_RENDERER` (`dom` or `webgl`) forces one, so the
 * render bench can compare the two builds.
 */
export type TerminalRenderer = "dom" | "webgl";
export type RendererChoice = TerminalRenderer | "auto";

export const rendererChoice = (value: string | undefined): RendererChoice =>
  value === "dom" || value === "webgl" ? value : "auto";

/** A software rasterizer's name in `UNMASKED_RENDERER_WEBGL`, as Chromium, Firefox and Mesa report it. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export const isGpuRenderer = (name: string): boolean => !SOFTWARE.test(name);

/**
 * Whether this browser draws WebGL2 on a GPU. Headless Chromium's SwiftShader passes `failIfMajorPerformanceCaveat`
 * (measured on Linux and macOS), so the renderer's name decides too; a browser that hides it is taken at its caveat
 * answer.
 */
export function gpuWebgl2(): boolean {
  if (typeof OffscreenCanvas === "undefined") return false;
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  if (gl === null) return false;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info === null ? "" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return isGpuRenderer(name);
}

export const terminalRenderer = (choice: RendererChoice, onGpu: () => boolean): TerminalRenderer =>
  choice === "auto" ? (onGpu() ? "webgl" : "dom") : choice;

export const TERMINAL_RENDERER: TerminalRenderer = terminalRenderer(
  rendererChoice(import.meta.env["VITE_TERMINAL_RENDERER"]),
  gpuWebgl2,
);
