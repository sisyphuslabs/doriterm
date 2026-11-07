// Renders every doriface icon raster from the SVG sources in ../brand: bun scripts/icons.ts
// The brand SVGs are the only source; nothing here is hand-exported. Outputs: the web favicons, PWA and
// touch icons in public/, and the Electron icons (icns, ico, png) in ../../desktop/build/.
import { chromium } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const BRAND = join(import.meta.dir, "../brand");
const PUBLIC = join(import.meta.dir, "../public");
const DESKTOP = join(import.meta.dir, "../../desktop/build");

const icon = await Bun.file(join(BRAND, "doriterm-icon.svg")).text();
const small = await Bun.file(join(BRAND, "doriterm-icon-small.svg")).text();

/** The tile colour and the art group of a brand icon, so the art can be re-framed. */
function parts(svg: string): { tile: string; art: string } {
  const tile = /<path id="tile" fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
  const art = /<g id="art">[\s\S]*?<\/g>/.exec(svg)?.[0];
  if (tile === undefined || art === undefined) throw new Error("brand icon lacks its tile or art group");
  return { tile, art };
}

/** The art on a full-bleed square, scaled about the centre: maskable and touch icons (the platform masks them). */
function fullBleed(svg: string, scale: number): string {
  const { tile, art } = parts(svg);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${tile}"/><g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${art}</g></svg>`;
}

/** The tile inset on Apple's icon grid (an 824 px body on a 1024 px canvas), for the macOS icns. */
function appleGrid(svg: string): string {
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(0.8046875)">${inner}</g></svg>`;
}

// Maskable safe zone: a circle of radius 40% of the size. The art's farthest corner sits 556 px from the
// centre at scale 1, so 0.7 keeps it at 389 px, inside the 410 px circle.
const maskable = fullBleed(icon, 0.7);
const touch = fullBleed(icon, 0.86);
const mac = appleGrid(icon);
const macSmall = appleGrid(small);

const browser = await chromium.launch();
async function png(svg: string, size: number): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`,
  );
  const shot = await page.screenshot({ omitBackground: true });
  await page.close();
  return shot;
}

/** An ICO whose entries are PNGs (Vista and later read them; electron-builder accepts them). */
function ico(images: readonly { size: number; data: Uint8Array }[]): Uint8Array {
  const head = new DataView(new ArrayBuffer(6 + 16 * images.length));
  head.setUint16(2, 1, true);
  head.setUint16(4, images.length, true);
  let offset = head.byteLength;
  images.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    head.setUint8(at, size >= 256 ? 0 : size);
    head.setUint8(at + 1, size >= 256 ? 0 : size);
    head.setUint16(at + 4, 1, true);
    head.setUint16(at + 6, 32, true);
    head.setUint32(at + 8, data.byteLength, true);
    head.setUint32(at + 12, offset, true);
    offset += data.byteLength;
  });
  return Buffer.concat([new Uint8Array(head.buffer), ...images.map(({ data }) => data)]);
}

/** An ICNS made of PNG chunks (the OSType says which size each one is). Only the PNG-capable slots are used:
 * the legacy 16/32/48 px slots (icp4-icp6) are read as raw bitmaps, and macOS takes those sizes from ic11/ic12. */
function icns(chunks: readonly { type: string; data: Uint8Array }[]): Uint8Array {
  const blocks = chunks.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(data.byteLength + 8, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + blocks.reduce((sum, block) => sum + block.byteLength, 0), 4);
  return Buffer.concat([header, ...blocks]);
}

await mkdir(DESKTOP, { recursive: true });
await copyFile(join(BRAND, "doriterm-icon.svg"), join(PUBLIC, "icon.svg"));
await copyFile(join(BRAND, "doriterm-icon-small.svg"), join(PUBLIC, "favicon.svg"));

const [f16, f32, i192, i512, mask192, mask512, touch180, linux512] = await Promise.all([
  png(small, 16),
  png(small, 32),
  png(icon, 192),
  png(icon, 512),
  png(maskable, 192),
  png(maskable, 512),
  png(touch, 180),
  png(icon, 512),
]);
const winSizes = [16, 24, 32, 48, 64, 128, 256];
const win = await Promise.all(
  winSizes.map(async (size) => ({ size, data: await png(size <= 32 ? small : icon, size) })),
);
const macChunks = [
  { type: "ic11", size: 32, art: macSmall },
  { type: "ic12", size: 64, art: macSmall },
  { type: "ic07", size: 128, art: mac },
  { type: "ic08", size: 256, art: mac },
  { type: "ic13", size: 256, art: mac },
  { type: "ic09", size: 512, art: mac },
  { type: "ic14", size: 512, art: mac },
  { type: "ic10", size: 1024, art: mac },
];
const macImages = await Promise.all(
  macChunks.map(async ({ type, size, art }) => ({ type, data: await png(art, size) })),
);
await browser.close();

await Promise.all([
  Bun.write(join(PUBLIC, "favicon-16.png"), f16),
  Bun.write(join(PUBLIC, "favicon-32.png"), f32),
  Bun.write(join(PUBLIC, "icon-192.png"), i192),
  Bun.write(join(PUBLIC, "icon-512.png"), i512),
  Bun.write(join(PUBLIC, "icon-maskable-192.png"), mask192),
  Bun.write(join(PUBLIC, "icon-maskable-512.png"), mask512),
  Bun.write(join(PUBLIC, "apple-touch-icon.png"), touch180),
  Bun.write(join(DESKTOP, "icon.png"), linux512),
  Bun.write(join(DESKTOP, "icon.ico"), ico(win)),
  Bun.write(join(DESKTOP, "icon.icns"), icns(macImages)),
]);
