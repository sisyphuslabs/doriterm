/** How long the probe keeps polling after the last scroll event so momentum tails are captured. */
const IDLE_STOP_MS = 150;
/** Default 120 Hz read interval before two requestAnimationFrame timestamps establish the cadence. */
const DEFAULT_STEP_MS = 1000 / 120;
/** Bounds outside which a requestAnimationFrame gap reflects a background pause rather than a display refresh. */
const MIN_RAF_DELTA_MS = 4;
const MAX_RAF_DELTA_MS = 40;
/** Threshold above which requestAnimationFrame is likely throttled to 60 Hz on a 120 Hz display. */
const THROTTLED_RAF_MS = 12;

/**
 * Reads a native scroller's offset on a vsync-phased MessageChannel loop while keeping an empty
 * requestAnimationFrame loop running. On iOS Safari with ProMotion, this reads 120 Hz compositor
 * scroll positions even when requestAnimationFrame itself is throttled to 60 Hz.
 */
export function readScrollController(
  scroller: HTMLElement,
  onSample: (x: number, y: number, at: number) => void,
): () => void {
  let stopped = false;
  let active = false;
  let pressing = false;
  let rafId: number | null = null;
  let tickTimer: number | null = null;
  let idleTimer: number | null = null;
  let lastRafAt: number | null = null;
  let stepMs = DEFAULT_STEP_MS;

  const channel = new MessageChannel();
  const listeners = new AbortController();

  const stopLoop = (): void => {
    active = false;
    lastRafAt = null;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (tickTimer !== null) {
      window.clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdleStop = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      if (!pressing) stopLoop();
    }, IDLE_STOP_MS);
  };

  const onRaf = (timestamp: number): void => {
    rafId = null;
    if (!active || stopped) return;
    if (lastRafAt !== null) {
      const delta = timestamp - lastRafAt;
      if (delta >= MIN_RAF_DELTA_MS && delta <= MAX_RAF_DELTA_MS) {
        // Halving a ~16.7 ms rAF period schedules one extra read between vsync-throttled callbacks.
        stepMs = delta > THROTTLED_RAF_MS ? delta / 2 : delta;
      }
    }
    lastRafAt = timestamp;
    rafId = window.requestAnimationFrame(onRaf);
  };

  const nextDelay = (now: number): number => {
    if (lastRafAt === null) return stepMs;
    const elapsed = now - lastRafAt;
    const slots = Math.floor(elapsed / stepMs) + 1;
    const target = lastRafAt + slots * stepMs;
    // Clamp away from zero so reduced timer precision cannot turn the phase-locked loop into a tight spin.
    return Math.max(1, Math.min(stepMs, target - now));
  };

  const onTick = (): void => {
    if (!active || stopped) return;
    const now = performance.now();
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    onSample(scroller.scrollLeft / dpr, scroller.scrollTop / dpr, now);
    if (!active || stopped) return;
    const delay = nextDelay(now);
    tickTimer = window.setTimeout(() => {
      tickTimer = null;
      if (active && !stopped) channel.port2.postMessage(null);
    }, delay);
  };

  const startLoop = (): void => {
    if (stopped || active) return;
    active = true;
    lastRafAt = null;
    rafId = window.requestAnimationFrame(onRaf);
    channel.port2.postMessage(null);
  };

  const onPressStart = (): void => {
    pressing = true;
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    startLoop();
  };

  const onPressEnd = (): void => {
    pressing = false;
    if (active) scheduleIdleStop();
  };

  const onScroll = (): void => {
    if (stopped) return;
    startLoop();
    scheduleIdleStop();
  };

  channel.port1.addEventListener("message", onTick, { signal: listeners.signal });
  channel.port1.start();

  const options = { passive: true, signal: listeners.signal };
  scroller.addEventListener("touchstart", onPressStart, options);
  scroller.addEventListener("pointerdown", onPressStart, options);
  scroller.addEventListener("touchend", onPressEnd, options);
  scroller.addEventListener("touchcancel", onPressEnd, options);
  scroller.addEventListener("pointerup", onPressEnd, options);
  scroller.addEventListener("pointercancel", onPressEnd, options);
  scroller.addEventListener("scroll", onScroll, options);

  return () => {
    if (stopped) return;
    stopped = true;
    pressing = false;
    listeners.abort();
    stopLoop();
    channel.port1.close();
    channel.port2.close();
  };
}
