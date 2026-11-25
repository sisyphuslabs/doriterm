/**
 * Transfers a canvas to a dedicated module worker so frames can be drawn and presented independently
 * of the main thread's animation cadence. Returns null when OffscreenCanvas transfer is unavailable.
 */
export function startOffscreenProbe(
  canvas: HTMLCanvasElement,
  onRate: (framesPerSecond: number) => void,
): (() => void) | null {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof Worker === "undefined" ||
    typeof canvas.transferControlToOffscreen !== "function"
  ) {
    return null;
  }

  let offscreen: OffscreenCanvas;
  try {
    offscreen = canvas.transferControlToOffscreen();
  } catch {
    return null;
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./offscreen-probe.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }

  worker.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const rate: unknown = Reflect.get(data, "framesPerSecond");
    if (typeof rate === "number" && Number.isFinite(rate)) onRate(rate);
  });

  try {
    worker.postMessage({ canvas: offscreen }, [offscreen]);
  } catch {
    worker.terminate();
    return null;
  }

  return () => {
    worker.terminate();
  };
}
