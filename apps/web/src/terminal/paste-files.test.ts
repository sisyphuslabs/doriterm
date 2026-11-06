import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@doriface/protocol";
import {
  base64Of,
  choosePaste,
  MAX_PUT_BYTES,
  putFiles,
  quotePaths,
  readClipboard,
  readClipboardImage,
  sendable,
  type ToPng,
} from "./paste-files.ts";

const png = (name = "image.png", size = 4): File =>
  new File([new Uint8Array(size).fill(7)], name, { type: "image/png" });
const noPng: ToPng = () => Promise.reject(new Error("unused"));
const twoBytePng: ToPng = () => Promise.resolve(new Blob([new Uint8Array([1, 2])], { type: "image/png" }));
const readText = () => Promise.resolve("from readText");
const denied = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
const reads = (items: readonly ClipboardItem[]) => () => Promise.resolve([...items]);

interface Put {
  readonly terminal: string;
  readonly name: string;
  readonly data: string;
}

/** A connection whose `terminal.put` lands each file under /there, or fails as `fail` says. */
function core(fail?: (put: Put) => HcRpcError | undefined) {
  const puts: Put[] = [];
  return {
    puts,
    connection: {
      call: (method: string, params: Put) => {
        expect(method).toBe("terminal.put");
        puts.push(params);
        const error = fail?.(params);
        return error === undefined
          ? Promise.resolve({ path: `/there/${params.name}`, bytes: 0 })
          : Promise.reject(error);
      },
    } as never,
  };
}

/** A clipboard item as the async clipboard API hands one over. */
const item = (entries: Readonly<Record<string, Blob>>): ClipboardItem =>
  ({ types: Object.keys(entries), getType: (type: string) => Promise.resolve(entries[type]) }) as never;

describe("choosePaste: herdr-app's order, copied files, then text, then an image alone", () => {
  test("an image alone goes as a file; text alone stays text", () => {
    const shot = png();
    expect(choosePaste("", [shot])).toEqual({ kind: "files", files: [shot] });
    expect(choosePaste("echo hi", [])).toEqual({ kind: "text" });
  });

  test("a file manager's copy, whose text is only the files' names or paths, goes as files", () => {
    const shot = png("shot 1.png");
    const doc = new File(["x"], "notes.pdf", { type: "application/pdf" });
    expect(choosePaste("shot 1.png", [shot]).kind).toBe("files");
    expect(choosePaste("/Users/me/Desktop/shot 1.png\n/Users/me/notes.pdf\n", [shot, doc]).kind).toBe("files");
  });

  test("an image beside other text is that text's picture, so the text is pasted", () => {
    expect(choosePaste("A1\tB1\nA2\tB2", [png()]).kind).toBe("text");
  });
});

test("quotePaths types paths as a shell reads them, as herdr-app's quote_paths", () => {
  expect(quotePaths(["/tmp/shot.png"])).toBe("/tmp/shot.png ");
  expect(quotePaths(["/tmp/my shot.png", "/a/b"])).toBe("'/tmp/my shot.png' /a/b ");
  expect(quotePaths(["/tmp/it's.png"])).toBe("'/tmp/it'\\''s.png' ");
});

test("base64Of encodes more than one slice the same as Buffer does", () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31) % 256);
  expect(base64Of(bytes)).toBe(Buffer.from(bytes).toString("base64"));
});

describe("sendable", () => {
  test("a clipboard image with the browser's generic name gets a name of its own", async () => {
    expect((await sendable(png("image.png"), noPng, () => 42)).name).toBe("doriface-paste-42.png");
    expect((await sendable(png(""), noPng, () => 42)).name).toBe("doriface-paste-42.png");
  });

  test("a dropped or copied file keeps its name and bytes", async () => {
    const ready = await sendable(png("diagram.png", 3), noPng);
    expect(ready.name).toBe("diagram.png");
    expect([...ready.bytes]).toEqual([7, 7, 7]);
  });

  test("an image type programs may not read (BMP, TIFF) goes as PNG", async () => {
    const bmp = new File([new Uint8Array([9])], "scan.bmp", { type: "image/bmp" });
    const ready = await sendable(bmp, twoBytePng);
    expect(ready.name).toBe("scan.png");
    expect([...ready.bytes]).toEqual([1, 2]);
    const tiff = new File([new Uint8Array([9])], "", { type: "image/tiff" });
    expect((await sendable(tiff, twoBytePng, () => 5)).name).toBe("doriface-paste-5.png");
  });
});

describe("putFiles", () => {
  test("puts each file on the terminal's machine and returns where each landed, in order", async () => {
    const { connection, puts } = core();
    const sent = await putFiles(connection, "build-box/t3", [png("a.png", 2), png("b.png", 1)], noPng);
    expect(sent).toEqual({ paths: ["/there/a.png", "/there/b.png"], refused: [] });
    expect(puts.map(({ terminal, name, data }) => [terminal, name, data])).toEqual([
      ["build-box/t3", "a.png", base64Of(new Uint8Array([7, 7]))],
      ["build-box/t3", "b.png", base64Of(new Uint8Array([7]))],
    ]);
  });

  test("a file past 8 MB is refused with a notice and sends nothing; the others still go", async () => {
    const { connection, puts } = core();
    const sent = await putFiles(connection, "t1", [png("big.png", MAX_PUT_BYTES + 1), png("ok.png")], noPng);
    expect(sent.paths).toEqual(["/there/ok.png"]);
    expect(sent.refused).toEqual(["big.png is 8.0 MB; at most 8 MB can be sent"]);
    expect(puts.map((put) => put.name)).toEqual(["ok.png"]);
  });

  test("exactly 8 MB is sent", async () => {
    const { connection } = core();
    expect((await putFiles(connection, "t1", [png("edge.png", MAX_PUT_BYTES)], noPng)).paths).toEqual([
      "/there/edge.png",
    ]);
  });

  test("a failed put names herdr's error kind", async () => {
    const finished = new HcRpcError({
      code: -32000,
      message: "t1 has finished",
      data: { kind: "finished", hint: "nothing there to read it" },
    });
    const { connection } = core(() => finished);
    expect(await putFiles(connection, "t1", [png("shot.png")], noPng)).toEqual({
      paths: [],
      refused: ["shot.png was not sent (finished: nothing there to read it)"],
    });
  });

  test("an image the browser cannot decode is refused", async () => {
    const { connection, puts } = core();
    const bmp = new File([new Uint8Array([0])], "broken.bmp", { type: "image/bmp" });
    expect((await putFiles(connection, "t1", [bmp], noPng)).refused).toEqual([
      "broken.bmp could not be read as an image",
    ]);
    expect(puts).toEqual([]);
  });
});

describe("readClipboard", () => {
  test("text first, as a paste event carries it", async () => {
    const read = reads([item({ "image/png": png(), "text/plain": new Blob(["cells"]) })]);
    expect(await readClipboard({ read, readText })).toEqual({ text: "cells" });
  });

  test("an image alone is a file", async () => {
    const read = reads([item({ "image/png": png("", 2) })]);
    const got = await readClipboard({ read, readText });
    if (!("files" in got)) throw new Error("expected files");
    expect(got.files.map((file) => [file.type, file.size])).toEqual([["image/png", 2]]);
  });

  test("without clipboard.read, or when it refuses, the text as before", async () => {
    expect(await readClipboard({ readText })).toEqual({ text: "from readText" });
    expect(await readClipboard({ read: denied, readText })).toEqual({ text: "from readText" });
  });
});

test("readClipboardImage is null without an image, so terminal.paste_image sends the key itself", async () => {
  expect(await readClipboardImage({})).toBeNull();
  expect(
    await readClipboardImage({ read: () => Promise.resolve([item({ "text/plain": new Blob(["x"]) })]) }),
  ).toBeNull();
  const image = await readClipboardImage({ read: () => Promise.resolve([item({ "image/webp": png() })]) });
  expect(image?.type).toBe("image/webp");
});

test("readClipboardImage is null, so the key itself is sent, when reading the clipboard fails in any way", async () => {
  const throwing = {
    read: (): Promise<ClipboardItem[]> => {
      throw new DOMException("denied", "NotAllowedError");
    },
  };
  expect(await readClipboardImage(throwing)).toBeNull();
  expect(await readClipboardImage({ read: denied })).toBeNull();
  const broken = {
    types: ["image/png"],
    getType: () => Promise.reject(new DOMException("gone", "NotFoundError")),
  } as never;
  expect(await readClipboardImage({ read: reads([broken]) })).toBeNull();
});
