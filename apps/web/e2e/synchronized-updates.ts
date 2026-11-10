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
 * (`ESC [ ? 2026 h` / `l` in a stream's payloads, a sequence split across frames or messages included). The pacer writes an open update as it
 * arrives, so its arrival is when wterm's hold of it starts.
 */
export async function watchSynchronizedUpdates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const SYNC = "\u001b[?2026";
    const HEADER = 9;
    /** packages/protocol FrameKind.Data. */
    const DATA = 0;
    const events: { t: number; open: boolean }[] = [];
    (window as unknown as { e2eSyncEvents: typeof events }).e2eSyncEvents = events;
    const Native = window.WebSocket;
    class Watched extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        // The connection speaks JSON-RPC lines until the hello reply (the line whose result says `"framed":true`); every
        // byte after that reply's LF is hc's wire frames: channel (u32), kind (u8), payload length (u32), little-endian,
        // then the payload, a frame possibly spanning messages. Only Data frames (kind 0) on a stream (channel > 0) carry
        // terminal output; each stream's are scanned on their own with what is left of a sequence its last one ended inside,
        // so a Resize or Credit frame between two halves of a sequence does not lose it.
        let framed = false;
        let lines = "";
        let rest = new Uint8Array(0);
        const tails = new Map<number, string>();
        const scan = (channel: number, payload: Uint8Array, t: number): void => {
          let text = tails.get(channel) ?? "";
          for (const byte of payload) text += String.fromCharCode(byte);
          let found = text.indexOf(SYNC);
          while (found !== -1 && found + SYNC.length < text.length) {
            const mode = text.charAt(found + SYNC.length);
            if (mode === "h" || mode === "l") events.push({ t, open: mode === "h" });
            found = text.indexOf(SYNC, found + 1);
          }
          const cut = text.lastIndexOf("\u001b");
          tails.set(
            channel,
            cut !== -1 && text.length - cut <= SYNC.length && SYNC.startsWith(text.slice(cut)) ? text.slice(cut) : "",
          );
        };
        this.addEventListener("message", (event: MessageEvent) => {
          if (!(event.data instanceof ArrayBuffer)) return;
          const t = performance.now();
          let incoming = new Uint8Array(event.data);
          if (!framed) {
            for (const byte of incoming) lines += String.fromCharCode(byte);
            let start = 0;
            for (let end = lines.indexOf("\n"); end !== -1; end = lines.indexOf("\n", start)) {
              const reply = lines.slice(start, end);
              start = end + 1;
              if (reply.indexOf('"framed":true') !== -1 && reply.indexOf('"result"') !== -1) {
                framed = true;
                break;
              }
            }
            if (!framed) {
              lines = lines.slice(start);
              return;
            }
            incoming = incoming.subarray(incoming.length - (lines.length - start));
            lines = "";
          }
          const joined = new Uint8Array(rest.length + incoming.length);
          joined.set(rest);
          joined.set(incoming, rest.length);
          let at = 0;
          for (;;) {
            if (joined.length - at < HEADER) break;
            const header = new DataView(joined.buffer, at, HEADER);
            const channel = header.getUint32(0, true);
            const kind = header.getUint8(4);
            const end = at + HEADER + header.getUint32(5, true);
            if (end > joined.length) break;
            if (channel !== 0 && kind === DATA) scan(channel, joined.subarray(at + HEADER, end), t);
            at = end;
          }
          rest = joined.slice(at);
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
