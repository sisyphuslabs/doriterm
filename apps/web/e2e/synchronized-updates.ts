import type { Page } from "@playwright/test";

/** How long wterm holds the paint of an open synchronized update before it paints anyway (@wterm/dom's SYNCHRONIZED_OUTPUT_TIMEOUT_MS). */
export const SYNC_HOLD_MS = 1_000;

/** A synchronized update (DECSET 2026) as it reached the page: when it opened and closed, by `performance.now()`. */
export interface SyncUpdate {
  readonly open: number;
  readonly close: number | null;
}

/**
 * Call before page.goto: records, page-side, when each synchronized update the hc socket carries opens and closes
 * (`ESC [ ? 2026 h` / `l`, a sequence split across two messages included). The pacer writes an open update as it
 * arrives, so its arrival is when wterm's hold of it starts.
 */
export async function watchSynchronizedUpdates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const SYNC = "\u001b[?2026";
    const events: { t: number; open: boolean }[] = [];
    (window as unknown as { e2eSyncEvents: typeof events }).e2eSyncEvents = events;
    const Native = window.WebSocket;
    class Watched extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        let tail = "";
        this.addEventListener("message", (event: MessageEvent) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          const t = performance.now();
          const view = new Uint8Array(event.data);
          let text = tail;
          for (const byte of view) text += String.fromCharCode(byte);
          let at = text.indexOf(SYNC);
          while (at !== -1 && at + SYNC.length < text.length) {
            const mode = text.charAt(at + SYNC.length);
            if (mode === "h" || mode === "l") events.push({ t, open: mode === "h" });
            at = text.indexOf(SYNC, at + 1);
          }
          // Keep what could be the start of a sequence the next message finishes.
          const cut = text.lastIndexOf("\u001b");
          tail =
            cut !== -1 && text.length - cut <= SYNC.length && SYNC.startsWith(text.slice(cut)) ? text.slice(cut) : "";
        });
      }
    }
    window.WebSocket = Watched as unknown as typeof WebSocket;
  });
}

/** The synchronized updates recorded so far, each open paired with the close that follows it. */
export async function synchronizedUpdates(page: Page): Promise<SyncUpdate[]> {
  const events = await page.evaluate(
    () => (window as unknown as { e2eSyncEvents: { t: number; open: boolean }[] }).e2eSyncEvents,
  );
  const updates: SyncUpdate[] = [];
  let opened: number | null = null;
  for (const event of events) {
    if (event.open && opened === null) opened = event.t;
    else if (!event.open && opened !== null) {
      updates.push({ open: opened, close: event.t });
      opened = null;
    }
  }
  if (opened !== null) updates.push({ open: opened, close: null });
  return updates;
}
