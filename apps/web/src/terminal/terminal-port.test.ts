import { describe, expect, test } from "bun:test";
import type { TerminalHandle } from "@wterm/react";
import { portOf } from "./terminal-port.ts";

/** A terminal whose field still holds a composing syllable, recording what reaches the program in order. */
function composing(syllable: string) {
  const order: string[] = [];
  let preedit = syllable;
  const instance = {
    takeComposition: () => {
      const taken = preedit;
      preedit = "";
      return taken;
    },
  };
  const handle = { current: { instance } as unknown as TerminalHandle };
  const send = (data: unknown): void => void order.push(`send:${String(data)}`);
  const pasteFiles = (files: readonly File[]): void =>
    void order.push(`files:${files.map((file) => file.name).join(",")}`);
  return { port: portOf(handle, send, pasteFiles), order };
}

describe("the terminal port", () => {
  test("pasting files sends a composing syllable first, so the syllable lands before the pasted path (#827)", () => {
    const { port, order } = composing("한");
    port.pasteFiles([new File([], "shot.png")]);
    expect(order).toEqual(["send:한", "files:shot.png"]);
  });

  test("with nothing composing, pasting files sends only the files", () => {
    const { port, order } = composing("");
    port.pasteFiles([new File([], "shot.png")]);
    expect(order).toEqual(["files:shot.png"]);
  });
});
