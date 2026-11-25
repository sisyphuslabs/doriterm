import { Button } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { startOffscreenProbe } from "../perf/offscreen-probe.ts";
import { RateCounter, type RateSnapshot } from "../perf/rate-counter.ts";
import { readScrollController } from "../perf/scroll-controller.ts";

/** Logical extent of the scroll controller surface before devicePixelRatio scaling. */
const SURFACE_PX = 4000;
const CONTROLLER_H = 240;
const CANVAS_W = 320;
const CANVAS_H = 72;
/** Each canvas probe runs alone for three seconds so WebKit's main thread and worker do not starve each other. */
const PHASE_MS = 3000;
const PANEL = "flex flex-col gap-2 rounded-lg border border-border bg-card p-3";
const ROW = "flex flex-wrap items-baseline justify-between gap-2";
const CANVAS_BOX = "h-[72px] w-full rounded-md border border-border bg-surface";

type FrameTestPhase = "main" | "worker" | "done";

const PHASE_LABEL: Readonly<Record<FrameTestPhase, string>> = {
  main: "Measuring main thread…",
  worker: "Measuring worker…",
  done: "Done",
};

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
      context.fillRect(barX, 0, 16, canvas.height);
      barX = (barX + 4) % Math.max(1, canvas.width);
    }
    if (windowStart === null) {
      windowStart = now;
    } else if (now - windowStart >= 1000) {
      onRate(Math.round(((frames + 1) * 1000) / (now - windowStart)));
      windowStart = now;
      frames = 0;
    } else {
      frames += 1;
    }
    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);
  return () => window.cancelAnimationFrame(rafId);
}

/**
 * Standalone device refresh-rate probe page at /perf. Measures native scroll read rates,
 * main-thread requestAnimationFrame presentation, and worker OffscreenCanvas presentation
 * sequentially without touching the workspace or dialling any host.
 */
export function PerfRoute() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerHostRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef({ controllerUpdates: 0, controllerUnique: 0, mainFps: 0, workerFps: 0 });

  const [controllerRate, setControllerRate] = useState<RateSnapshot>({ perSecond: 0, uniquePerSecond: 0 });
  const [mainFps, setMainFps] = useState(0);
  const [workerFps, setWorkerFps] = useState(0);
  const [workerAvailable, setWorkerAvailable] = useState(true);
  const [phase, setPhase] = useState<FrameTestPhase>("main");
  const [runId, setRunId] = useState(1);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "failed">("idle");

  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const userAgent = navigator.userAgent;
  const screenSize = `${window.screen.width}x${window.screen.height}`;

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
      if (!shownSample || at - lastUiPush >= 100) {
        shownSample = true;
        lastUiPush = at;
        setControllerRate(snapshot);
      }
    });

    const decayTimer = window.setInterval(() => {
      const next = counter.rates(performance.now());
      setControllerRate((prev) =>
        prev.perSecond === next.perSecond && prev.uniquePerSecond === next.uniquePerSecond ? prev : next,
      );
    }, 250);

    return () => {
      stopController();
      window.clearInterval(decayTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stopProbe: (() => void) | null = null;
    let timer: number | null = null;

    const clearActive = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      stopProbe?.();
      stopProbe = null;
    };

    const runPhase = (stop: () => void, after: () => void): void => {
      stopProbe = stop;
      timer = window.setTimeout(() => {
        clearActive();
        if (!cancelled) after();
      }, PHASE_MS);
    };

    const startWorkerPhase = (): void => {
      const host = workerHostRef.current;
      if (host === null) {
        setPhase("done");
        return;
      }
      setPhase("worker");
      // Create a fresh canvas per run because transferControlToOffscreen is one-shot per element.
      const canvas = Object.assign(document.createElement("canvas"), {
        width: CANVAS_W,
        height: CANVAS_H,
        className: "block h-full w-full",
      });
      host.replaceChildren(canvas);

      const stop = startOffscreenProbe(canvas, (fps) => {
        if (cancelled) return;
        peaksRef.current.workerFps = Math.max(peaksRef.current.workerFps, fps);
        setWorkerFps(fps);
      });
      if (stop === null) {
        canvas.remove();
        setWorkerAvailable(false);
        setPhase("done");
        return;
      }
      setWorkerAvailable(true);
      runPhase(stop, () => setPhase("done"));
    };

    const mainCanvas = mainCanvasRef.current;
    if (mainCanvas === null) {
      startWorkerPhase();
    } else {
      setPhase("main");
      runPhase(
        startMainCanvasProbe(mainCanvas, (fps) => {
          if (cancelled) return;
          peaksRef.current.mainFps = Math.max(peaksRef.current.mainFps, fps);
          setMainFps(fps);
        }),
        startWorkerPhase,
      );
    }

    return () => {
      cancelled = true;
      clearActive();
      workerHostRef.current?.replaceChildren();
    };
  }, [runId]);

  const copyResults = (): void => {
    const line = JSON.stringify({ ua: userAgent, dpr, ...peaksRef.current, at: new Date().toISOString() });
    void (async () => {
      try {
        await navigator.clipboard.writeText(line);
        setCopyFeedback("copied");
      } catch {
        setCopyFeedback("failed");
      }
    })();
  };

  const scaledBoxStyle = {
    width: `${dpr * 100}%`,
    height: `${CONTROLLER_H * dpr}px`,
    transform: `scale(${1 / dpr})`,
    transformOrigin: "0 0",
  };
  const surfaceStyle = { width: `${SURFACE_PX * dpr}px`, height: `${SURFACE_PX * dpr}px` };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 bg-background px-4 py-6 text-foreground">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Refresh-rate probe</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => setRunId((id) => id + 1)}>
            Run frame test
          </Button>
          <div role="status" aria-label="Frame test phase" className="font-mono text-xs text-muted-foreground">
            {PHASE_LABEL[phase]}
          </div>
        </div>
      </header>

      <section role="group" aria-label="Scroll controller" className={PANEL}>
        <div className={ROW}>
          <h2 className="text-sm font-medium">Scroll controller</h2>
          <div role="status" aria-label="Scroll controller rate" className="flex flex-wrap gap-3 font-mono text-xs">
            <span>Updates/s {controllerRate.perSecond}</span>
            <span>Unique values/s {controllerRate.uniquePerSecond}</span>
          </div>
        </div>
        <div className="relative h-[240px] w-full overflow-hidden rounded-md border border-border bg-surface">
          {/* Scale the container by 1/dpr and its inner surface by dpr so sub-point positions survive integer scrollTop. */}
          <div style={scaledBoxStyle}>
            <div ref={scrollerRef} data-perf-scroller className="h-full w-full overflow-scroll">
              <div style={surfaceStyle}>
                <div className="p-4 text-sm text-muted-foreground">Swipe or scroll in any direction</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section role="group" aria-label="Main thread canvas" className={PANEL}>
        <div className={ROW}>
          <h2 className="text-sm font-medium">Main thread canvas</h2>
          <div role="status" aria-label="Main thread rate" className="font-mono text-xs">
            Frames/s {mainFps}
          </div>
        </div>
        <canvas ref={mainCanvasRef} width={CANVAS_W} height={CANVAS_H} className={`block ${CANVAS_BOX}`} />
      </section>

      <section role="group" aria-label="Worker canvas" className={PANEL}>
        <div className={ROW}>
          <h2 className="text-sm font-medium">Worker canvas</h2>
          <div role="status" aria-label="Worker rate" className="font-mono text-xs">
            {workerAvailable ? `Frames/s ${workerFps}` : "OffscreenCanvas is not available here"}
          </div>
        </div>
        <div ref={workerHostRef} className={`overflow-hidden ${CANVAS_BOX}`} />
      </section>

      <footer className={`${PANEL} gap-3 text-xs text-muted-foreground`}>
        <div className="flex flex-col gap-1 font-mono">
          <span>{`DPR ${dpr} · Screen ${screenSize}`}</span>
          <span className="break-all">{userAgent}</span>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" onClick={copyResults}>
            Copy results
          </Button>
          {copyFeedback !== "idle" ? (
            <span className={copyFeedback === "copied" ? "text-foreground" : "text-destructive"}>
              {copyFeedback === "copied" ? "Copied" : "Copy failed"}
            </span>
          ) : null}
        </div>
      </footer>
    </main>
  );
}
