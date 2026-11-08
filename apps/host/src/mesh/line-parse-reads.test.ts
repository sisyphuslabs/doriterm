import { describe, expect, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { parseLine } from "./line-parse.ts";

const MESH = "meshid";
const hash = (seed: string): string => base64urlEncode(new TextEncoder().encode(seed.padEnd(32, ".")));
const hello = (extra: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ t: "hello", v: 2, mesh: MESH, heads: [hash("a")], n: {}, ...extra });

describe("a hello's reads", () => {
  test("carries the formats the peer says it reads", () => {
    expect(parseLine(hello({ reads: [2, 3] }))).toEqual({
      t: "hello",
      v: 2,
      mesh: MESH,
      heads: [hash("a")],
      n: {},
      reads: [2, 3],
    });
  });

  test("an older peer that sends no reads parses, and says nothing rather than claiming support", () => {
    const parsed = parseLine(hello({}));
    expect(parsed).toMatchObject({ t: "hello" });
    if (parsed === undefined || parsed === "unknown" || parsed.t !== "hello") throw new Error("not a hello");
    expect(parsed.reads).toBeUndefined();
  });

  test("a malformed reads is refused instead of read as support", () => {
    expect(parseLine(hello({ reads: "3" }))).toBeUndefined();
    expect(parseLine(hello({ reads: [2, 0] }))).toBeUndefined();
    expect(parseLine(hello({ reads: [2, 1.5] }))).toBeUndefined();
    expect(parseLine(hello({ reads: [null] }))).toBeUndefined();
  });
});
