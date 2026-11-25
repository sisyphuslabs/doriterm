/// <reference lib="webworker" />

/** What the worker posts back once a second: frames it presented in that second. Exporting it keeps this file a module. */
export interface OffscreenProbeReport {
  readonly framesPerSecond: number;
}

declare const self: DedicatedWorkerGlobalScope;

/** Horizontal distance the probe bar advances on each presented worker frame. */
const STEP_PX = 4;
/** Width of the moving bar drawn across the transferred OffscreenCanvas. */
const BAR_WIDTH_PX = 16;
/** Reporting cadence for worker frame-rate updates sent back to the main thread. */
const REPORT_INTERVAL_MS = 1000;

let rafId: number | null = null;

/** Runs the worker-owned presentation loop on a transferred OffscreenCanvas. */
function runProbe(canvas: OffscreenCanvas): void {
  const context = canvas.getContext("2d");
  if (context === null || typeof self.requestAnimationFrame !== "function") return;

  if (rafId !== null) {
    self.cancelAnimationFrame(rafId);
    rafId = null;
  }

  let barX = 0;
  let windowStart: number | null = null;
  let frames = 0;

  const drawFrame = (now: number): void => {
    const width = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#38bdf8";
    context.fillRect(barX, 0, BAR_WIDTH_PX, height);
    barX = (barX + STEP_PX) % width;

    if (windowStart === null) {
      windowStart = now;
      frames = 0;
    } else {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= REPORT_INTERVAL_MS) {
        const framesPerSecond = Math.round((frames * 1000) / elapsed);
        // DedicatedWorkerGlobalScope.postMessage accepts an empty transfer list as its second argument.
        self.postMessage({ framesPerSecond } satisfies OffscreenProbeReport, []);
        windowStart = now;
        frames = 0;
      }
    }

    rafId = self.requestAnimationFrame(drawFrame);
  };

  rafId = self.requestAnimationFrame(drawFrame);
}

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return;
  const canvas: unknown = Reflect.get(data, "canvas");
  if (canvas instanceof OffscreenCanvas) runProbe(canvas);
});
