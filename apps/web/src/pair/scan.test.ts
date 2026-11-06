import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";
import { encode } from "uqr";
import { hostIdOf } from "./fragment.ts";
import {
  type Frame,
  type ScanHandles,
  ScanError,
  decodePixels,
  offerFromScan,
  pollForCode,
  startScan,
} from "./scan.ts";

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const signPub = new Uint8Array(32).fill(7);
const noisePub = new Uint8Array(32).fill(9);
const inviteLink = (overrides: Readonly<Record<string, string>> = {}): string =>
  "https://app.doriterm.com/pair#" +
  new URLSearchParams({
    h: hostIdOf(signPub),
    k: b64url(noisePub),
    s: b64url(signPub),
    p: b64url(new Uint8Array(32).fill(3)),
    r: "wss://relay.invalid",
    ...overrides,
  }).toString();

/** The frame a camera would hand the decoder: the QR's modules rasterised at four pixels each, opaque. */
function frameOf(text: string): Frame {
  const { data, size } = encode(text, { border: 4 });
  const scale = 4;
  const side = size * scale;
  const pixels = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const dark = data[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      const at = (y * side + x) * 4;
      const value = dark ? 0 : 255;
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = 255;
    }
  }
  return { data: pixels, width: side, height: side };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  const box: { settle?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    box.settle = resolve;
  });
  return { promise, resolve: (value: T) => box.settle?.(value) };
}

function handlesSpy(): { handles: ScanHandles; stops: () => number } {
  let stops = 0;
  const track = {
    stop: () => {
      stops += 1;
    },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return {
    handles: {
      stream,
      stop: () => {
        stops += 1;
      },
    },
    stops: () => stops,
  };
}

describe("offerFromScan", () => {
  test("a scanned invite link becomes the same offer the pasted link makes", () => {
    const scanned = offerFromScan(inviteLink());
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.offer.hostId).toBe(hostIdOf(signPub));
    expect(scanned.offer.relayUrl).toBe("wss://relay.invalid");
  });

  test("a scan with no fragment is refused, and says why", () => {
    const scanned = offerFromScan("https://app.doriterm.com/pair");
    expect(scanned.ok).toBe(false);
    if (scanned.ok) return;
    expect(scanned.reason).toContain("no invite");
  });

  test("a code that is not an invite link is refused rather than navigated to", () => {
    expect(offerFromScan("https://example.com/").ok).toBe(false);
    expect(offerFromScan("hello").ok).toBe(false);
    expect(offerFromScan("").ok).toBe(false);
  });

  test("a bare pairing code is not an offer: the scan path never starts a relay lookup", () => {
    expect(offerFromScan("ABCD2345").ok).toBe(false);
  });

  test("an invite link whose secret is the wrong length is refused by the spec's own parser", () => {
    expect(offerFromScan(inviteLink({ p: "short" })).ok).toBe(false);
  });

  test("an invite link whose hostId does not match its signing key is refused", () => {
    expect(offerFromScan(inviteLink({ h: hostIdOf(new Uint8Array(32).fill(1)) })).ok).toBe(false);
  });
});

describe("decodePixels", () => {
  test("the bundled decoder reads the invite link out of a real QR frame", () => {
    const link = inviteLink();
    expect(decodePixels(jsQR, frameOf(link))).toBe(link);
  });

  test("a blank frame decodes to nothing rather than to an empty string", () => {
    const blank: Frame = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    expect(decodePixels(jsQR, blank)).toBeUndefined();
  });
});

describe("pollForCode", () => {
  test("keeps reading until a frame carries a code", async () => {
    const frames = [undefined, undefined, inviteLink()];
    const text = await pollForCode(async () => frames.shift(), { everyMs: 1 });
    expect(text).toBe(inviteLink());
  });

  test("a stop ends the loop as stopped, not as a camera failure", async () => {
    const controller = new AbortController();
    const running = pollForCode(
      async () => {
        controller.abort();
        return undefined;
      },
      { everyMs: 1, signal: controller.signal },
    );
    await expect(running).rejects.toBeInstanceOf(ScanError);
    await running.catch((cause: unknown) => {
      expect(cause instanceof ScanError && cause.failure).toBe("stopped");
    });
  });

  test("running out of time is its own failure, so the screen can say no code was read", async () => {
    const running = pollForCode(async () => undefined, { everyMs: 1, timeoutMs: 5 });
    await running.catch((cause: unknown) => {
      expect(cause instanceof ScanError && cause.failure).toBe("timeout");
    });
    await expect(running).rejects.toBeInstanceOf(ScanError);
  });
});

describe("startScan", () => {
  test("a stop tapped while the camera request is still pending stops the stream when it arrives", async () => {
    const controller = new AbortController();
    const spy = handlesSpy();
    const opened = deferred<ScanHandles>();
    const running = startScan({
      video: { srcObject: null } as unknown as HTMLVideoElement,
      signal: controller.signal,
      open: () => opened.promise,
    });
    controller.abort();
    opened.resolve(spy.handles);
    await running.catch((cause: unknown) => {
      expect(cause instanceof ScanError && cause.failure).toBe("stopped");
    });
    expect(spy.stops()).toBe(1);
  });

  test("a preview that cannot play still stops the stream", async () => {
    const spy = handlesSpy();
    const element = {
      srcObject: null,
      play: async () => {
        throw new Error("AbortError: the play() request was interrupted");
      },
    } as unknown as HTMLVideoElement;
    const running = startScan({
      video: element,
      signal: new AbortController().signal,
      open: async () => spy.handles,
    });
    await expect(running).rejects.toThrow("the play() request was interrupted");
    expect(spy.stops()).toBe(1);
    expect(element.srcObject).toBeNull();
  });

  test("a finished scan stops the tracks and clears the preview", async () => {
    const spy = handlesSpy();
    const element = { srcObject: null, play: async () => {} } as unknown as HTMLVideoElement;
    const text = await startScan({
      video: element,
      signal: new AbortController().signal,
      open: async () => spy.handles,
      read: async () => inviteLink(),
    });
    expect(text).toBe(inviteLink());
    expect(spy.stops()).toBe(1);
    expect(element.srcObject).toBeNull();
  });
});
