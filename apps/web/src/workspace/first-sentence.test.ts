import { expect, test } from "bun:test";
import { firstSentence } from "./first-sentence.ts";

test("a status bar notice keeps its first sentence whole", () => {
  expect(firstSentence("build-box isn't answering. Check that it's on. Doriterm keeps trying to reach it.")).toBe(
    "build-box isn't answering.",
  );
  expect(firstSentence("doriface-host isn't running on build-box, or it lost its connection. Start it there.")).toBe(
    "doriface-host isn't running on build-box, or it lost its connection.",
  );
  expect(firstSentence("v0.1.21 is too old")).toBe("v0.1.21 is too old");
});
