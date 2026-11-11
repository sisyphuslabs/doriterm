import type { Page, WebSocketRoute } from "@playwright/test";
import { encodeFailure, parseJsonRpc } from "@doriface/protocol";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { MACHINE_NAME } from "./machine.ts";

/** A gateway on the LAN rather than on this computer: a lost network concerns it. */
export const LAN_HC_URL = `ws://studio.lan:${E2E_HOST_PORT}/v1/hc`;

/** Call before page.goto: carries the page's connections to LAN_HC_URL to the e2e host, as the LAN would. */
export async function routeLanToHost(page: Page): Promise<void> {
  await page.routeWebSocket(LAN_HC_URL, (socket) => {
    const host = new WebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, ["doriface.v1", `doriface.token.${E2E_TOKEN}`]);
    host.binaryType = "arraybuffer";
    const early: (string | Uint8Array<ArrayBuffer>)[] = [];
    host.addEventListener("open", () => {
      for (const frame of early.splice(0)) host.send(frame);
    });
    socket.onMessage((message) => {
      const frame = typeof message === "string" ? message : Uint8Array.from(message);
      if (host.readyState === WebSocket.OPEN) host.send(frame);
      else early.push(frame);
    });
    host.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) =>
      socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data)),
    );
    host.addEventListener(
      "close",
      (event) => void socket.close({ code: event.code === 1000 ? 1000 : 1011, reason: event.reason }),
    );
    socket.onClose(() => host.close());
  });
}

/** The page's hc WebSocket, routed through the spec so it can lag like the relay and drop like a relay blip. */
export interface HcSocket {
  readonly opened: () => number;
  /** Reconnects refused while down: one or more means the page has noticed the drop. */
  readonly refused: () => number;
  /** Every frame the page has sent, in order, as text (the RPC JSON inside a frame reads as latin1). */
  readonly sent: () => readonly string[];
  /** Holds every later frame from the host `ms`, in order, as a relay round trip does. */
  readonly delay: (ms: number) => void;
  /** Hands later frames from the host over at most `bytesPerSecond`, as a slow link does; Infinity lifts the limit. */
  readonly throttle: (bytesPerSecond: number) => void;
  /** Closes every open connection; while `down` is true the page's reconnects are refused. */
  readonly drop: (down: boolean) => Promise<void>;
  readonly restore: () => void;
  /**
   * Holds the page's requests for these methods (others pass) until the returned release sends them, in order. With
   * `fail`, each is sent as a same-length unknown method instead, so hc answers it with an RPC error.
   */
  readonly hold: (...methods: string[]) => (fail?: boolean) => void;
  /** Every frame the host has delivered to the page, in order, as text. */
  readonly received: () => readonly string[];
  /**
   * How many messages the host has sent, before their frames are told apart: one page message per message the host's
   * stream is cut into, as a page read from a real socket has it.
   */
  readonly messages: () => number;
  /**
   * Holds hc frames from the host that contain any of these texts (others pass, even from the same message) until the
   * returned release delivers them, in order; holds are independent. Hold a channel's whole stream, not one event in
   * it: the feed drops an event older than one it has seen.
   */
  readonly holdFromHost: (...needles: string[]) => () => void;
  /** Delivers a frame to the page as if the host had sent it, on every open connection. */
  readonly sendFromHost: (frame: Buffer) => void;
  /**
   * While on, every layout write the page sends (`doc.set`) names a version the document is not at, so the host refuses
   * each one as a conflict, as when another device keeps changing the layout: the page's retries run out.
   */
  readonly staleWrites: (on: boolean) => void;
  /** Refuse the next count attaches with a real RPC failure, leaving other calls and the program untouched. */
  readonly refuseAttaches: (kind: string, count: number) => void;
}

interface HostHold {
  readonly needles: readonly string[];
  readonly parked: (() => void)[];
}

/** hc's wire frame header: channel (u32), kind (u8), payload length (u32), little-endian. */
const HEADER_BYTES = 9;

/** Splits one WebSocket message into its hc frames; bytes after the last whole frame stay one piece. */
function hcFrames(message: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (message.byteLength - offset >= HEADER_BYTES) {
    const end = offset + HEADER_BYTES + message.readUInt32LE(offset + 5);
    if (end > message.byteLength) break;
    frames.push(message.subarray(offset, end));
    offset = end;
  }
  if (offset < message.byteLength) frames.push(message.subarray(offset));
  return frames;
}

/** The hc frame with its `doc.set` request's version moved off the document's, or the frame itself when it is no write. */
function staleWrite(frame: Buffer): Buffer {
  if (frame.byteLength < HEADER_BYTES) return frame;
  const text = frame.subarray(HEADER_BYTES).toString("utf8");
  if (!text.includes('"method":"doc.set"')) return frame;
  const request: unknown = JSON.parse(text);
  const params = typeof request === "object" && request !== null ? Reflect.get(request, "params") : undefined;
  const version = typeof params === "object" && params !== null ? Reflect.get(params, "version") : undefined;
  if (typeof version !== "number") return frame;
  Reflect.set(params, "version", version + 1_000_000);
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  const header = Buffer.from(frame.subarray(0, HEADER_BYTES));
  header.writeUInt32LE(payload.byteLength, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Call before page.goto: every connection to the e2e host passes through the returned handle. `observe` subscribes to
 * frames as they are sent or delivered, so a spec can await a particular request or answer without polling.
 */
export async function routeHcSocket(
  page: Page,
  observe?: { readonly sent?: (frame: string) => void; readonly received?: (frame: string) => void },
): Promise<HcSocket> {
  const live = new Set<WebSocketRoute>();
  const sent: string[] = [];
  let down = false;
  let opened = 0;
  let refused = 0;
  let delay = 0;
  let rate = Number.POSITIVE_INFINITY;
  let lastDue = 0;
  let hostMessages = 0;
  let held: readonly string[] = [];
  let stale = false;
  let refusal = { kind: "", left: 0 };
  const parked: ((fail: boolean) => void)[] = [];
  const received: string[] = [];
  const hostHolds = new Set<HostHold>();
  await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, (socket) => {
    const deliverOne = (frame: Buffer | string, text: string): void => {
      received.push(text);
      observe?.received?.(text);
      socket.send(frame);
    };
    if (down) {
      refused += 1;
      void socket.close({ code: 1011, reason: "host unreachable" });
      return;
    }
    const host = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = stale && typeof message !== "string" ? Buffer.concat(hcFrames(message).map(staleWrite)) : message;
      const text = typeof frame === "string" ? frame : frame.toString("latin1");
      sent.push(text);
      observe?.sent?.(text);
      if (refusal.left > 0 && typeof frame !== "string" && text.includes('"method":"terminal.attach"')) {
        const request = parseJsonRpc(frame.subarray(HEADER_BYTES).toString("utf8"));
        if (request.kind === "request") {
          refusal.left -= 1;
          const payload = Buffer.from(
            encodeFailure(request.id, { code: -32000, message: refusal.kind, data: { kind: refusal.kind } }),
          );
          const header = Buffer.from(frame.subarray(0, HEADER_BYTES));
          header.writeUInt32LE(payload.byteLength, 5);
          socket.send(Buffer.concat([header, payload]));
          return;
        }
      }
      const method = held.find((name) => text.includes(`"method":"${name}"`));
      if (method === undefined) host.send(frame);
      else
        parked.push((fail) => {
          const broken = `"method":"${method.slice(0, -1)}${method.endsWith("x") ? "y" : "x"}"`;
          host.send(fail ? Buffer.from(text.replace(`"method":"${method}"`, broken), "latin1") : frame);
        });
    });
    // Delayed frames leave in the order they came: one queue per connection, drained by one timer at a time. A timer per
    // frame does not keep that order when the delay changes between frames, since timers due at the same moment can fire
    // in either order (#1640 review: an echo arrived as "remotet yping").
    const queued: { readonly at: number; readonly deliver: () => void }[] = [];
    let draining = false;
    const drain = (): void => {
      const next = queued[0];
      if (next === undefined) {
        draining = false;
        return;
      }
      draining = true;
      setTimeout(
        () => {
          queued.shift();
          next.deliver();
          drain();
        },
        Math.max(0, next.at - Date.now()),
      );
    };
    host.onMessage((message) => {
      hostMessages += 1;
      // One message can carry several hc frames (an event and an RPC answer together): each is held or passed alone,
      // and those that pass go on as one message, the cut the host made. A frame of its own is a driver round trip
      // into the page, and a terminal's echo is many tiny frames: one per frame, the page trails the core by seconds
      // on a loaded machine, and a spec reading the grid sees a line that has not arrived yet (#1462).
      const due: Buffer[] = [];
      const dueText: string[] = [];
      const pass = (): void => {
        for (const text of dueText) {
          received.push(text);
          observe?.received?.(text);
        }
        const whole = due.length === 1 ? due[0] : due.length > 1 ? Buffer.concat(due) : undefined;
        if (whole !== undefined) socket.send(whole);
        due.length = 0;
        dueText.length = 0;
      };
      for (const frame of typeof message === "string" ? [message] : hcFrames(message)) {
        const text = typeof frame === "string" ? frame : frame.toString("latin1");
        const hold = [...hostHolds].find((entry) => entry.needles.some((needle) => text.includes(needle)));
        if (hold !== undefined) {
          pass();
          hold.parked.push(() => deliverOne(frame, text));
          continue;
        }
        lastDue = Math.max(Date.now() + delay, lastDue) + (frame.length / rate) * 1000;
        const wait = Math.max(0, lastDue - Date.now());
        if (wait > 0 || draining || typeof frame === "string") {
          // A lagged frame (delayed or throttled) goes on the ordered queue, and so does any frame behind one still
          // queued (a delay just lowered to 0), so nothing overtakes it. Text is never joined to binary.
          pass();
          queued.push({ at: lastDue, deliver: () => deliverOne(frame, text) });
          if (!draining) drain();
          continue;
        }
        due.push(frame);
        dueText.push(text);
      }
      pass();
    });
    live.add(socket);
    opened += 1;
  });
  return {
    opened: () => opened,
    refused: () => refused,
    sent: () => sent,
    delay: (ms) => void (delay = ms),
    throttle: (bytesPerSecond) => void (rate = bytesPerSecond),
    drop: async (stayDown) => {
      down = stayDown;
      const closing = [...live].map((socket) => socket.close({ code: 1011, reason: "relay blip" }));
      live.clear();
      await Promise.all(closing);
    },
    restore: () => {
      down = false;
    },
    received: () => received,
    messages: () => hostMessages,
    holdFromHost: (...needles) => {
      const hold: HostHold = { needles, parked: [] };
      hostHolds.add(hold);
      return () => {
        hostHolds.delete(hold);
        for (const deliver of hold.parked.splice(0)) deliver();
      };
    },
    sendFromHost: (frame) => {
      for (const socket of live) socket.send(frame);
    },
    staleWrites: (on) => void (stale = on),
    refuseAttaches: (kind, count) => {
      refusal = { kind, left: count };
    },
    hold: (...methods) => {
      held = methods;
      return (fail = false) => {
        held = [];
        for (const send of parked.splice(0)) send(fail);
      };
    },
  };
}

/** A WebSocket message as text: JSON-RPC sits in it as plain UTF-8 after each frame header. */
export const frameText = (message: string | Buffer): string =>
  typeof message === "string" ? message : message.toString("latin1");

/**
 * Holds the core's answer to the page's first read of the added machine's layout until `release`, so a terminal opened
 * meanwhile finds that layout still loading and gets a tab of this screen's own (#459). `requested` resolves once the
 * page has sent that read: the page reads a machine's layout only after the feed reports it connected.
 */
export async function holdMachineLayout(page: Page): Promise<{
  readonly requested: (timeoutMs: number) => Promise<void>;
  readonly release: () => void;
}> {
  const held: (() => void)[] = [];
  let holding = true;
  let asked: RegExp | undefined;
  const sent = Promise.withResolvers<void>();
  await page.routeWebSocket(/\/v1\/hc/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const text = frameText(message);
      const id = /"id":(\d+),"method":"doc\.get"/.exec(text)?.[1];
      if (holding && asked === undefined && id !== undefined && text.includes(`"on":"${MACHINE_NAME}"`)) {
        asked = new RegExp(`"id":${id}[,}]`);
        sent.resolve();
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (holding && asked?.test(frameText(message)) === true) held.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  return {
    requested: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the page did not request the machine's layout within ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([sent.promise, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    release: () => {
      if (asked === undefined) throw new Error("the page never requested the machine's layout");
      holding = false;
      for (const send of held.splice(0)) send();
    },
  };
}
