// Kitty image helpers shared by the terminal image specs: build images, print them through the shell, read the cells.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export const SIZE = 24;

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A SIZE x SIZE PNG of one color (8-bit RGB). */
export function png(rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: SIZE }, () => rgb).flat()]);
  const pixels = Buffer.concat(Array.from({ length: SIZE }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const RED = [255, 0, 0] as const;
export const BLUE = [0, 0, 255] as const;
export const graphics = (control: string, payload = ""): string => `\u001b_G${control};${payload}\u001b\\`;
/** Kitty's own chunking: the first chunk carries the keys, the rest only `m`. */
export function chunked(control: string, payload: string, size: number): string {
  const parts = payload.match(new RegExp(`.{1,${size}}`, "g")) ?? [];
  return parts
    .map((part, index) => graphics(index === 0 ? `${control},m=1` : `m=${index < parts.length - 1 ? 1 : 0}`, part))
    .join("");
}

/** Has the shell print `mark` on its own line, then `bytes` (from a file, so nothing long is typed), then `done-<mark>`. */
export async function show(page: Page, terminal: Locator, mark: string, bytes: string): Promise<void> {
  const file = join(mkdtempSync(join(tmpdir(), "dh-images-")), "out");
  // Graphics controls and base64 are ASCII; Kitty placeholder cells and their diacritics are UTF-8.
  writeFileSync(file, bytes, "utf8");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`echo ${mark}; cat ${file}; echo; echo done-${mark}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(terminal)).includes(`done-${mark}`), { timeout: 15_000 }).toBe(true);
}

export const liveRows = (terminal: Locator) => terminal.locator(".term-row:not(.term-scrollback-row)");
export const images = (terminal: Locator) => terminal.locator("canvas.term-image");
/** The live rows' text, each without the blank cells after it. */
export const lines = async (terminal: Locator) =>
  (await liveRows(terminal).allTextContents()).map((line) => line.replace(/[\s\u00a0]+$/u, ""));

/**
 * Where the image placed right after MARK's line is drawn: the image canvas over the first cell of the row below MARK,
 * and that point's color in it.
 */
async function drawnBelow(terminal: Locator, mark: string) {
  return terminal.evaluate((root, text) => {
    const rows = [...root.querySelectorAll<HTMLElement>(".term-row:not(.term-scrollback-row)")];
    // The last row that reads MARK is echo's: a long command line can wrap onto a row that reads it too.
    const marked = rows.findLast((row) => row.textContent?.trim() === text);
    if (marked === undefined) return null;
    const cell = marked.getBoundingClientRect();
    const x = cell.left + 4;
    const y = cell.bottom + 4;
    // The image layer takes no pointer events, so hit testing skips it: the canvas is found by its box.
    const hit = [...root.querySelectorAll<HTMLCanvasElement>("canvas.term-image")].find((canvas) => {
      const box = canvas.getBoundingClientRect();
      return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    });
    if (hit === undefined) {
      return { image: false, top: null, left: null, cellTop: cell.bottom, cellLeft: cell.left, rgb: null };
    }
    const box = hit.getBoundingClientRect();
    const scale = hit.width / box.width;
    const pixel = hit
      .getContext("2d")
      ?.getImageData(Math.floor((x - box.left) * scale), Math.floor((y - box.top) * scale), 1, 1).data;
    return {
      image: true,
      top: Math.round(box.top),
      left: Math.round(box.left),
      cellTop: Math.round(cell.bottom),
      cellLeft: Math.round(cell.left),
      rgb: pixel === undefined ? null : [pixel[0], pixel[1], pixel[2]],
    };
  }, mark);
}

export async function expectImageBelow(terminal: Locator, mark: string, rgb: readonly number[]): Promise<void> {
  await expect
    .poll(async () => {
      const drawn = await drawnBelow(terminal, mark);
      return drawn !== null && drawn.image && drawn.top === drawn.cellTop && drawn.left === drawn.cellLeft
        ? drawn.rgb
        : drawn;
    })
    .toEqual([...rgb]);
}
