import { parsePairingFragment, type PairingParse } from "./fragment.ts";

/**
 * Why a scan ended without a code. The screen titles its notice from this rather than from a message, so a person who
 * tapped Stop is not told the camera failed, and a timeout is not reported as a camera that never started.
 */
export type ScanFailure = "stopped" | "timeout" | "unsupported" | "decode";

export class ScanError extends Error {
  readonly failure: ScanFailure;

  constructor(failure: ScanFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

/** What a decoded code means: only a pairing link is accepted, and only through the spec's own parser. */
export function offerFromScan(text: string): PairingParse {
  const hash = text.indexOf("#");
  if (hash === -1) return { ok: false, reason: "That code is not an invite link: it carries no invite." };
  return parsePairingFragment(text.slice(hash));
}

/** A frame as `getImageData` yields it; structural so a decoder test can build one without a canvas. */
export interface Frame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export type DecodeQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { readonly inversionAttempts: "dontInvert" },
) => { readonly data: string } | null;

export function decodePixels(decode: DecodeQr, frame: Frame): string | undefined {
  const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
  return found === null || found.data === "" ? undefined : found.data;
}

export interface ScanHandles {
  readonly stream: MediaStream;
  readonly stop: () => void;
}

const UNSUPPORTED = "This browser cannot read QR codes. Open the invite link instead.";

export interface CodeSource {
  readonly detect: (video: HTMLVideoElement) => Promise<string | undefined>;
}

/** Opens the rear camera. The caller owns the stream and must call `stop`. */
export async function openCamera(): Promise<ScanHandles> {
  const media = navigator.mediaDevices;
  if (media === undefined || typeof media.getUserMedia !== "function") {
    throw new Error("This browser has no camera access. Open the invite link instead.");
  }
  const stream = await media.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  return { stream, stop: () => stream.getTracks().forEach((track) => track.stop()) };
}

interface DetectedCode {
  readonly rawValue?: unknown;
}

async function supportsQrCodes(): Promise<boolean> {
  const detector: unknown = Reflect.get(globalThis, "BarcodeDetector");
  if (typeof detector !== "function") return false;
  try {
    const formats: unknown = await Reflect.get(detector, "getSupportedFormats").call(detector);
    return Array.isArray(formats) && formats.includes("qr_code");
  } catch {
    return false;
  }
}

async function decodeVideo(video: HTMLVideoElement, decode: DecodeQr): Promise<string | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  if (canvas.width === 0 || canvas.height === 0) return undefined;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return undefined;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return decodePixels(decode, context.getImageData(0, 0, canvas.width, canvas.height));
}

async function barcodeDetectorSource(): Promise<CodeSource> {
  const Detector: unknown = Reflect.get(globalThis, "BarcodeDetector");
  if (typeof Detector !== "function") throw new ScanError("unsupported", UNSUPPORTED);
  const detector: unknown = Reflect.construct(Detector, [{ formats: ["qr_code"] }]);
  const detect: unknown = Reflect.get(Object(detector), "detect");
  return {
    detect: async (video) => {
      if (video.readyState < video.HAVE_CURRENT_DATA || typeof detect !== "function") return undefined;
      const codes: unknown = await Reflect.apply(detect, detector, [video]);
      if (!Array.isArray(codes)) return undefined;
      for (const code of codes as readonly DetectedCode[]) {
        const value = code.rawValue;
        if (typeof value === "string" && value !== "") return value;
      }
      return undefined;
    },
  };
}

async function jsqrSource(): Promise<CodeSource> {
  let decode: DecodeQr;
  try {
    const { default: jsQR } = await import("jsqr");
    decode = jsQR;
  } catch {
    throw new ScanError("unsupported", UNSUPPORTED);
  }
  return { detect: async (video) => decodeVideo(video, decode) };
}

/**
 * BarcodeDetector ships on Android Chrome and not on iOS Safari, so the bundled decoder is the fallback; a browser can
 * also expose the API without supporting qr_code, hence the question rather than the assumption. Chosen once per scan:
 * the detector is stateful, and jsqr stays unloaded on the browsers that do not need it.
 */
export async function chooseCodeSource(): Promise<CodeSource> {
  return (await supportsQrCodes()) ? barcodeDetectorSource() : jsqrSource();
}

export async function scanOnce(
  video: HTMLVideoElement,
  options: { readonly signal?: AbortSignal; readonly everyMs?: number; readonly timeoutMs?: number } = {},
): Promise<string> {
  const source = await chooseCodeSource();
  return pollForCode(() => source.detect(video), options);
}

export interface PollOptions {
  readonly signal?: AbortSignal;
  readonly everyMs?: number;
  readonly timeoutMs?: number;
}

/** The polling loop on its own, so its three endings are tested without a camera or a DOM. */
export async function pollForCode(read: () => Promise<string | undefined>, options: PollOptions = {}): Promise<string> {
  const everyMs = options.everyMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopBecause = (failure: ScanFailure, reason: string): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new ScanError(failure, reason));
    };
    const tick = async (): Promise<void> => {
      if (options.signal?.aborted === true) return stopBecause("stopped", "The scan was stopped.");
      let text: string | undefined;
      try {
        text = await read();
      } catch (cause) {
        return stopBecause("decode", cause instanceof Error ? cause.message : String(cause));
      }
      if (text !== undefined) {
        if (timer !== undefined) clearTimeout(timer);
        return resolve(text);
      }
      if (Date.now() > deadline) {
        return stopBecause("timeout", "No QR code was read. Move closer, or open the invite link instead.");
      }
      timer = setTimeout(() => void tick(), everyMs);
    };
    void tick();
  });
}

export interface StartScanOptions {
  readonly video: HTMLVideoElement | null;
  readonly signal: AbortSignal;
  readonly open?: () => Promise<ScanHandles>;
  readonly read?: (video: HTMLVideoElement, options: { readonly signal: AbortSignal }) => Promise<string>;
}

/**
 * One scan's whole lifetime: opens the camera, hands the stream to the preview, reads a code, and stops the tracks on
 * every exit. A stop or an unmount that lands while the camera request is still pending stops the stream the moment it
 * arrives, which is the only place that can: the component is already gone by then.
 */
export async function startScan(options: StartScanOptions): Promise<string> {
  const open = options.open ?? openCamera;
  const read = options.read ?? scanOnce;
  const handles = await open();
  const element = options.video;
  if (options.signal.aborted || element === null) {
    handles.stop();
    throw new ScanError("stopped", "The scan was stopped.");
  }
  element.srcObject = handles.stream;
  try {
    await element.play();
    return await read(element, { signal: options.signal });
  } finally {
    handles.stop();
    element.srcObject = null;
  }
}
