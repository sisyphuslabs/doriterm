import type { HcConnection } from "@doriface/client";
import { HcRpcError } from "@doriface/protocol";

/** The most raw bytes one `terminal.put` takes (herdr-core's `put::MAX_BYTES`, 8 MiB). */
export const MAX_PUT_BYTES = 8 << 20;

/** Image types a program reads as they are; any other image is sent as PNG, as herdr-app converts TIFF and BMP. */
const KEPT_IMAGES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** What a paste carries to the terminal: its text, as it always did, or files to put on the terminal's machine. */
export type PasteChoice = { readonly kind: "text" } | { readonly kind: "files"; readonly files: readonly File[] };

/** The files a paste or a drop carries: `files`, or the file items where a browser lists only those. */
export function filesOf(data: DataTransfer | null): File[] {
  if (data === null) return [];
  if (data.files.length > 0) return [...data.files];
  return [...data.items].flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file === null ? [] : [file];
  });
}

const baseName = (line: string): string => line.trim().split(/[/\\]/).at(-1) ?? "";

/** A file manager's copy: the text beside the files is only their names or paths, one a line. */
function namesOnly(text: string, files: readonly File[]): boolean {
  const names = new Set(files.map((file) => file.name));
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => names.has(baseName(line)));
}

/**
 * herdr-app's order (`paste()` in src/terminal.rs): copied files first, then text, then an image alone. Files a file
 * manager copied come with their names as text, which an agent reads as words, so they go as files; an image beside
 * other text is that text's picture (a spreadsheet's cells, a page's selection), so the text is pasted.
 */
export function choosePaste(text: string, files: readonly File[]): PasteChoice {
  if (files.length === 0) return { kind: "text" };
  if (text.trim() === "" || namesOnly(text, files)) return { kind: "files", files };
  return { kind: "text" };
}

/** Paths as a POSIX shell reads them, herdr-app's `quote_paths`: plain when safe, else single-quoted; a space after. */
const quotePath = (path: string): string =>
  path !== "" && /^[A-Za-z0-9/._\-+=,:@%~]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

export function quotePaths(paths: readonly string[]): string {
  return `${paths.map(quotePath).join(" ")} `;
}

/** Bytes as base64, in slices small enough for `String.fromCharCode`'s argument limit. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Re-encodes an image as PNG; rejects when the browser cannot decode it. */
export type ToPng = (image: Blob) => Promise<Blob>;

export const browserToPng: ToPng = async (image) => {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas");
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
};

/** A name the browser gives every clipboard image ("image.png"), or none: the file gets a name of its own. */
const GENERIC_NAME = /^(image\.[a-z0-9]+)?$/i;

export interface Sendable {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * The file as it is sent: an image of a type programs may not read becomes PNG, and an image with no name or the name a
 * browser gives every clipboard image (`image.<ext>`) is named `doriface-paste-<time>.<ext>`, as herdr-app names
 * `herdr-paste-<time>.<ext>`; a dropped file with that very name is renamed the same way. Every other file keeps its
 * name; the core adds a suffix when the name is taken.
 */
export async function sendable(file: File, toPng: ToPng, now: () => number = Date.now): Promise<Sendable> {
  const image = file.type.startsWith("image/");
  const kept = KEPT_IMAGES[file.type];
  const converted = image && kept === undefined;
  const blob = converted ? await toPng(file) : file;
  const ext = converted ? "png" : kept;
  let name = file.name;
  if (image && GENERIC_NAME.test(name)) name = `doriface-paste-${now()}.${ext ?? "png"}`;
  else if (converted) name = `${name.replace(/\.[^./\\]*$/, "")}.png`;
  return { name, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

export interface PutOutcome {
  /** Where each sent file landed, as the terminal's machine sees it, in the order given. */
  readonly paths: readonly string[];
  /** One line per file that was not sent, for a notice. */
  readonly refused: readonly string[];
}

/** A refused size, rounded up to a tenth so a file just past the limit never reads as the limit itself (#827). */
const megabytesUp = (bytes: number): string => `${(Math.ceil((bytes / (1 << 20)) * 10) / 10).toFixed(1)} MB`;

/** Why a put failed, by herdr's error kind, as herdr-app's notices name it. */
function failure(cause: unknown): string {
  if (cause instanceof HcRpcError) return cause.hint === undefined ? cause.kind : `${cause.kind}: ${cause.hint}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Sends one file; a string says why it was not sent. */
async function putOne(
  connection: Pick<HcConnection, "call">,
  terminal: string,
  file: File,
  toPng: ToPng,
): Promise<{ readonly path: string } | string> {
  let ready: Sendable;
  try {
    ready = await sendable(file, toPng);
  } catch {
    return `${file.name || "The image"} could not be read as an image`;
  }
  if (ready.bytes.length > MAX_PUT_BYTES) {
    return `${ready.name} is ${megabytesUp(ready.bytes.length)}; at most 8 MB can be sent`;
  }
  try {
    const put = await connection.call("terminal.put", { terminal, name: ready.name, data: base64Of(ready.bytes) });
    return { path: put.path };
  } catch (cause) {
    return `${ready.name} was not sent (${failure(cause)})`;
  }
}

/**
 * Puts each file beside the terminal, on the terminal's machine (`terminal.put`, this machine's or an added one's
 * alike). A file past the core's 8 MB is refused here and sends nothing; the others still go.
 */
export async function putFiles(
  connection: Pick<HcConnection, "call">,
  terminal: string,
  files: readonly File[],
  toPng: ToPng = browserToPng,
): Promise<PutOutcome> {
  const sent = await Promise.all(files.map((file) => putOne(connection, terminal, file, toPng)));
  return {
    paths: sent.flatMap((one) => (typeof one === "string" ? [] : [one.path])),
    refused: sent.filter((one) => typeof one === "string"),
  };
}

const imageType = (item: ClipboardItem): string | undefined => item.types.find((kind) => kind.startsWith("image/"));

/** The clipboard's image, for `terminal.paste_image`; null when it holds none or cannot be read in any way. */
export async function readClipboardImage(clipboard: Partial<Pick<Clipboard, "read">>): Promise<File | null> {
  try {
    const items = (await clipboard.read?.()) ?? [];
    const item = items.find((one) => imageType(one) !== undefined);
    const type = item === undefined ? undefined : imageType(item);
    if (item === undefined || type === undefined) return null;
    return new File([await item.getType(type)], "", { type });
  } catch {
    return null;
  }
}

/** How long Paste image waits for the clipboard before it counts as holding no image (#1989). */
export const CLIPBOARD_IMAGE_WAIT_MS = 1500;

/**
 * The clipboard's image as `readClipboardImage` reads it, or null once `waitMs` pass with no answer (a browser still
 * asking the person, a read that never settles), so keys held behind Paste image's ^V never wait longer (#1989). An
 * image that comes later is dropped: the ^V has gone in its place.
 */
export function readClipboardImageWithin(
  clipboard: Partial<Pick<Clipboard, "read">>,
  waitMs: number = CLIPBOARD_IMAGE_WAIT_MS,
): Promise<File | null> {
  const { promise, resolve } = Promise.withResolvers<File | null>();
  const timer = setTimeout(() => resolve(null), waitMs);
  return Promise.race([readClipboardImage(clipboard), promise]).finally(() => clearTimeout(timer));
}

/**
 * The clipboard as the Paste key and menu read it: text first, then an image alone, as a paste event carries them.
 * Where the browser cannot read anything but text (no `clipboard.read`, or it refuses), the text as before.
 */
export async function readClipboard(
  clipboard: Pick<Clipboard, "readText"> & Partial<Pick<Clipboard, "read">>,
): Promise<{ readonly text: string } | { readonly files: readonly File[] }> {
  const items = clipboard.read === undefined ? null : await clipboard.read().catch(() => null);
  if (items === null) return { text: await clipboard.readText() };
  const texts = await Promise.all(
    items
      .filter((item) => item.types.includes("text/plain"))
      .map(async (item) => (await item.getType("text/plain")).text()),
  );
  const text = texts.find((one) => one !== "");
  if (text !== undefined) return { text };
  const image = await readClipboardImage({ read: () => Promise.resolve(items) });
  return image === null ? { text: "" } : { files: [image] };
}
