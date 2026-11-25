import { Button } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { startOffscreenProbe } from "../perf/offscreen-probe.ts";
import { RateCounter, type RateSnapshot } from "../perf/rate-counter.ts";
import { readScrollController } from "../perf/scroll-controller.ts";

/** Logical size of the scroll controller surface before devicePixelRatio scaling. */
const SURFACE_EXTENT_PX = 4000;
const CONTROLLER_HEIGHT_PX = 240;
const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 72;
const BAR_STEP_PX = 4;
const BAR_WIDTH_PX = 16;
const UI_THROTTLE_MS = 100;
const DECAY_TICK_MS = 250;

/** Peak measurements kept across the lifetime of the probe page for clipboard export. */
interface PeakResults {
  controllerUpdates: number;
  controllerUnique: number;
  mainFps: number;
  workerFps: number;
}

/** Packs two-axis scroll coordinates into one finite integer key with 0.001 px resolution. */
function packScrollPosition(x: number, y: number): number {
  return Math.round(y * 1000) * 10_000_000 + Math.round(x * 1000);
}

/** Runs the main-thread requestAnimationFrame bar probe and reports frames per second once a second. */
function startMainCanvasProbe(canvas: HTMLCanvasElement, onRate: (fps: number) => void): () => void {
  const context = canvas.getContext("2d");
  let barX = 0;
  let windowStart: number | null = null;
  let frames = 0;
  let rafId = 0;

  const tick = (now: number): void => {
    if (context !== null) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#34d399";
      context.fillRect(barX, 0, BAR_WIDTH_PX, canvas.height);
      barX = (barX + BAR_STEP_PX) % Math.max(1, canvas.width);
    }
    if (windowStart === null) {
      windowStart = now;
      frames = 0;
    } else {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        onRate(Math.round((frames * 1000) / elapsed));
        windowStart = now;
        frames = 0;
      }
    }
    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);
  return () => window.cancelAnimationFrame(rafId);
}

/**
 * Standalone device refresh-rate probe page at /perf. Measures native scroll read rates,
 * main-thread requestAnimationFrame presentation, and worker OffscreenCanvas presentation
 * without touching the workspace or dialling any host.
 */
export function PerfRoute() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerHostRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<PeakResults>({ controllerUpdates: 0, controllerUnique: 0, mainFps: 0, workerFps: 0 });

  const [controllerRate, setControllerRate] = useState<RateSnapshot>({ perSecond: 0, uniquePerSecond: 0 });
  const [mainFps, setMainFps] = useState(0);
  const [workerFps, setWorkerFps] = useState(0);
  const [workerAvailable, setWorkerAvailable] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "failed">("idle");

  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const screenSize = typeof window !== "undefined" ? `${window.screen.width}x${window.screen.height}` : "0x0";

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const counter = new RateCounter();
    let lastUiPush = 0;
    let shownSample = false;

    const stopController = readScrollController(scroller, (x, y, at) => {
      counter.add(packScrollPosition(x, y), at);
      const snapshot = counter.rates(at);
      peaksRef.current.controllerUpdates = Math.max(peaksRef.current.controllerUpdates, snapshot.perSecond);
      peaksRef.current.controllerUnique = Math.max(peaksRef.current.controllerUnique, snapshot.uniquePerSecond);
      if (!shownSample || at - lastUiPush >= UI_THROTTLE_MS) {
        shownSample = true;
        lastUiPush = at;
        setControllerRate(snapshot);
      }
    });

    const decayTimer = window.setInterval(() => {
      const snapshot = counter.rates(performance.now());
      setControllerRate((prev) =>
        prev.perSecond === snapshot.perSecond && prev.uniquePerSecond === snapshot.uniquePerSecond ? prev : snapshot,
      );
    }, DECAY_TICK_MS);

    return () => {
      stopController();
      window.clearInterval(decayTimer);
    };
  }, []);

  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (canvas === null) return;
    return startMainCanvasProbe(canvas, (fps) => {
      peaksRef.current.mainFps = Math.max(peaksRef.current.mainFps, fps);
      setMainFps(fps);
    });
  }, []);

  useEffect(() => {
    const host = workerHostRef.current;
    if (host === null) return;
    // Create a fresh canvas per effect lifecycle because transferControlToOffscreen is one-shot per element.
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvas.className = "block h-full w-full";
    host.append(canvas);

    const stop = startOffscreenProbe(canvas, (fps) => {
      peaksRef.current.workerFps = Math.max(peaksRef.current.workerFps, fps);
      setWorkerFps(fps);
    });
    if (stop === null) {
      canvas.remove();
      setWorkerAvailable(false);
      return;
    }

    setWorkerAvailable(true);
    return () => {
      stop();
      canvas.remove();
    };
  }, []);

  const copyResults = (): void => {
    const line = JSON.stringify({
      ua: userAgent,
      dpr,
      controllerUpdates: peaksRef.current.controllerUpdates,
      controllerUnique: peaksRef.current.controllerUnique,
      mainFps: peaksRef.current.mainFps,
      workerFps: peaksRef.current.workerFps,
      at: new Date().toISOString(),
    });
    void (async () => {
      try {
        await navigator.clipboard.writeText(line);
        setCopyFeedback("copied");
      } catch {
        setCopyFeedback("failed");
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 bg-background px-4 py-6 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Refresh-rate probe</h1>
        <p className="text-sm text-muted-foreground">
          Drag or flick the scroll surface below to compare native scroll reads against main-thread and worker frames.
        </p>
      </header>

      <section
        role="group"
        aria-label="Scroll controller"
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Scroll controller</h2>
          <div role="status" aria-label="Scroll controller rate" className="flex flex-wrap gap-3 font-mono text-xs">
            <span>Updates/s {controllerRate.perSecond}</span>
            <span>Unique values/s {controllerRate.uniquePerSecond}</span>
          </div>
        </div>
        <div
          className="relative w-full overflow-hidden rounded-md border border-border bg-surface"
          style={{ height: `${CONTROLLER_HEIGHT_PX}px` }}
        >
          {/* Scale the container by 1/dpr and its inner surface by dpr so sub-point positions survive integer scrollTop. */}
          <div
            style={{
              width: `${dpr * 100}%`,
              height: `${CONTROLLER_HEIGHT_PX * dpr}px`,
              transform: `scale(${1 / dpr})`,
              transformOrigin: "0 0",
            }}
          >
            <div ref={scrollerRef} data-perf-scroller className="h-full w-full overflow-scroll">
              <div style={{ width: `${SURFACE_EXTENT_PX * dpr}px`, height: `${SURFACE_EXTENT_PX * dpr}px` }}>
                <div className="p-4 text-sm text-muted-foreground">Swipe or scroll in any direction</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        role="group"
        aria-label="Main thread canvas"
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Main thread canvas</h2>
          <div role="status" aria-label="Main thread rate" className="font-mono text-xs">
            Frames/s {mainFps}
          </div>
        </div>
        <canvas
          ref={mainCanvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="block h-[72px] w-full rounded-md border border-border bg-surface"
        />
      </section>

      <section
        role="group"
        aria-label="Worker canvas"
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Worker canvas</h2>
          <div role="status" aria-label="Worker rate" className="font-mono text-xs">
            {workerAvailable ? `Frames/s ${workerFps}` : "OffscreenCanvas is not available here"}
          </div>
        </div>
        <div
          ref={workerHostRef}
          className="h-[72px] w-full overflow-hidden rounded-md border border-border bg-surface"
        />
      </section>

      <footer className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
        <dl className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-x-2">
            <dt className="font-medium text-foreground">DPR</dt>
            <dd className="font-mono">{dpr}</dd>
            <dt className="ml-2 font-medium text-foreground">Screen</dt>
            <dd className="font-mono">{screenSize}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">User agent</dt>
            <dd className="break-all font-mono">{userAgent}</dd>
          </div>
        </dl>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" onClick={copyResults}>
            Copy results
          </Button>
          {copyFeedback === "copied" ? <span className="text-foreground">Copied</span> : null}
          {copyFeedback === "failed" ? <span className="text-destructive">Copy failed</span> : null}
        </div>
      </footer>
    </main>
  );
}
