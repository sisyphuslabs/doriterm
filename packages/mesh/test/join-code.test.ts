import { base64urlEncode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { createHash, hkdfSync } from "node:crypto";
import { joinCode, joinCommit, parseLine } from "../src/join/index.ts";

const h = new Uint8Array(32).fill(1);
const Ni = new Uint8Array(32).fill(2);
const Nj = new Uint8Array(32).fill(3);
const encoded = base64urlEncode(Ni);

test("the join code and commitment implement the section 9 byte construction", () => {
  const commit = createHash("sha256").update("doriface/1.3 join commit").update(h).update(Ni).digest("base64url");
  const bytes = hkdfSync("sha256", Buffer.concat([h, Ni, Nj]), "", "doriface/1.3 mesh join code", 4);
  const digits = String(new DataView(bytes).getUint32(0) % 1_000_000).padStart(6, "0");
  expect(joinCommit(h, Ni)).toBe(commit);
  expect(joinCode(h, Ni, Nj)).toBe(`${digits.slice(0, 3)} ${digits.slice(3)}`);
});

describe("join and roster wire lines", () => {
  test.each([
    { t: "offer", mesh: "mesh", inviter: "inviter", nonce: "nonce", commit: encoded },
    { t: "card", body: "body", sig: "sig", sas: encoded },
    { t: "reveal", Ni: encoded },
    { t: "confirm" },
    { t: "abort" },
    { t: "resume", nonce: "nonce" },
    { t: "leave", card: { body: "body", sig: "sig" } },
  ])("decodes $t without discarding its binding fields", (line) => {
    expect(parseLine(JSON.stringify(line))).toEqual(line);
  });

  test.each(["", "short", `${encoded}=`, encoded.slice(1), 42, null])(
    "refuses malformed commitment contributions %s",
    (value) => {
      expect(
        parseLine(JSON.stringify({ t: "offer", mesh: "m", inviter: "i", nonce: "n", commit: value })),
      ).toBeUndefined();
      expect(parseLine(JSON.stringify({ t: "card", body: "b", sig: "s", sas: value }))).toBeUndefined();
      expect(parseLine(JSON.stringify({ t: "reveal", Ni: value }))).toBeUndefined();
    },
  );

  test("refuses incomplete roster requests", () => {
    expect(parseLine('{"t":"resume"}')).toBeUndefined();
    expect(parseLine('{"t":"leave","card":{}}')).toBeUndefined();
  });
});
