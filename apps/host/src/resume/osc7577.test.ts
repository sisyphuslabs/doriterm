import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_ARGV, MAX_REPORT_BYTES, Osc7577Scanner, verifyReport } from "./osc7577.ts";

// The spec's own examples (Program Resume Protocol 0.5, "Examples"): the token and every mac below are its.
const TOKEN = "dummy-token-replace-me";
const T = 1795543200;
const NVIM =
  "pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b";
const NVIM_CLEAR =
  "pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93";
const LAZYGIT =
  "pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1";
const WRAP =
  "pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
/** The body with its correct mac for `token`, as a program computes it. */
const signed = (rest: string, token = TOKEN): string =>
  `${rest}:mac=${createHash("sha256").update(`${rest}:${token}`).digest("hex")}`;
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const verify = (body: string, options: { token?: string; now?: number; last?: number } = {}) =>
  verifyReport(bytes(body), options.token ?? TOKEN, options.now ?? T, () => options.last);

describe("verifyReport: the spec's valid reports", () => {
  test("Neovim's report decodes to its three arguments", () => {
    expect(verify(NVIM)).toEqual({
      kind: "report",
      pid: 74877,
      time: T,
      argv: ["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"],
      cwd: undefined,
    });
  });

  test("Neovim's clear names its owner", () => {
    expect(verify(NVIM_CLEAR)).toEqual({ kind: "clear", pid: 74877, time: T });
  });

  test("lazygit's report carries its working directory", () => {
    expect(verify(LAZYGIT)).toEqual({
      kind: "report",
      pid: 74877,
      time: T,
      argv: ["lazygit"],
      cwd: "/home/user/src/project",
    });
  });

  test("the resume-wrap report names the wrapper first", () => {
    expect(verify(WRAP)).toMatchObject({ kind: "report", pid: 90412, argv: ["resume-wrap", "ssh", "devbox"] });
  });

  test("an empty element after the first is an empty argument, and padding is optional", () => {
    expect(verify(signed(`pid=7:time=${T}:argv=bnZpbQ,,LVM`))).toMatchObject({ argv: ["nvim", "", "-S"] });
  });

  test("unknown keys are ignored, and need may name keys this terminal implements", () => {
    expect(verify(signed(`pid=7:time=${T}:later=x.y:need=cwd,argv:argv=${b64("nvim")}`))).toMatchObject({
      kind: "report",
      argv: ["nvim"],
    });
  });
});

describe("verifyReport: the spec's invalid reports table", () => {
  const nvim = b64("nvim");
  test("a mac that does not match is ignored", () => {
    expect(verify(`pid=74877:time=${T}:argv=${nvim}:mac=${"0".repeat(64)}`)).toMatchObject({ kind: "ignored" });
  });
  test("no mac is ignored", () => {
    expect(verify(`pid=74877:time=${T}:argv=${nvim}`)).toMatchObject({ kind: "ignored" });
  });
  test("a mac that is not the last key is ignored", () => {
    const good = signed(`pid=74877:time=${T}:argv=${nvim}`);
    const mac = good.slice(good.lastIndexOf(":mac=") + 1);
    expect(verify(`${mac}:pid=74877:time=${T}:argv=${nvim}`)).toMatchObject({ kind: "ignored" });
  });
  test("a time too far from the clock is ignored", () => {
    expect(verify(signed(`pid=74877:time=1000000000:argv=${nvim}`))).toMatchObject({ kind: "ignored" });
  });
  test("no time is ignored", () => {
    expect(verify(signed(`pid=74877:argv=${nvim}`))).toMatchObject({ kind: "ignored" });
  });
  test("a relative first element is rejected, naming its owner", () => {
    expect(verify(signed(`pid=74877:time=${T}:argv=${b64("./run.sh")}`))).toMatchObject({
      kind: "rejected",
      pid: 74877,
    });
  });
  test("argv with clear is rejected", () => {
    expect(verify(signed(`pid=74877:time=${T}:argv=${nvim}:clear=1`))).toMatchObject({ kind: "rejected", pid: 74877 });
  });
  test("a relative cwd is rejected", () => {
    expect(verify(signed(`pid=74877:time=${T}:argv=${nvim}:cwd=${b64("project")}`))).toMatchObject({
      kind: "rejected",
      pid: 74877,
    });
  });
  test("a need key this terminal does not implement is rejected", () => {
    expect(verify(signed(`pid=74877:time=${T}:argv=${nvim}:need=later`))).toMatchObject({ kind: "rejected" });
  });
});

describe("verifyReport: mac and time come first", () => {
  test("a report made with another terminal's token is ignored", () => {
    expect(verify(signed(`pid=7:time=${T}:argv=${b64("nvim")}`, "another-token-of-22-chars"))).toMatchObject({
      kind: "ignored",
    });
  });
  test("a malformed report with a wrong mac is ignored, never rejected (no record may change)", () => {
    expect(verify(`pid=7:time=${T}:argv=${b64("./x")}:mac=${"a".repeat(64)}`)).toMatchObject({ kind: "ignored" });
  });
  test("a mac in capitals is not the hex the spec defines", () => {
    const good = signed(`pid=7:time=${T}:argv=${b64("nvim")}`);
    expect(verify(good.slice(0, -64) + good.slice(-64).toUpperCase())).toMatchObject({ kind: "ignored" });
  });
  test("within the 60 s window either side it verifies; past it, it is ignored", () => {
    const body = signed(`pid=7:time=${T}:argv=${b64("nvim")}`);
    expect(verify(body, { now: T + 60 })).toMatchObject({ kind: "report" });
    expect(verify(body, { now: T - 60 })).toMatchObject({ kind: "report" });
    expect(verify(body, { now: T + 61 })).toMatchObject({ kind: "ignored" });
    expect(verify(body, { now: T - 61 })).toMatchObject({ kind: "ignored" });
  });
  test("a time earlier than the pid's last accepted report is ignored; the same second is not", () => {
    const body = signed(`pid=7:time=${T}:argv=${b64("nvim")}`);
    expect(verify(body, { last: T + 1 })).toMatchObject({ kind: "ignored" });
    expect(verify(body, { last: T })).toMatchObject({ kind: "report" });
  });
  test("a time too large to represent is ignored", () => {
    expect(verify(signed(`pid=7:time=${"9".repeat(40)}:argv=${b64("nvim")}`))).toMatchObject({ kind: "ignored" });
  });
  test("a body of ? is ignored", () => {
    expect(verify("?")).toMatchObject({ kind: "ignored" });
  });
});

describe("verifyReport: strict parsing rejects", () => {
  const cases: [string, string][] = [
    ["a repeated key", `pid=7:pid=7:time=${T}:argv=${b64("nvim")}`],
    ["a malformed pair", `pid=7:time=${T}:argv=${b64("nvim")}:oops`],
    ["a capital key", `pid=7:time=${T}:Argv=${b64("nvim")}`],
    ["no argv and no clear", `pid=7:time=${T}`],
    ["an empty argv", `pid=7:time=${T}:argv=`],
    ["an empty first element", `pid=7:time=${T}:argv=,${b64("x")}`],
    ["a bare command starting with -", `pid=7:time=${T}:argv=${b64("-rf")}`],
    ["a relative first element", `pid=7:time=${T}:argv=${b64("bin/x")}`],
    ["clear other than 1", `pid=7:time=${T}:clear=2`],
    ["base64 with the URL alphabet", `pid=7:time=${T}:argv=${b64("nvim")}:cwd=L2hvbWU_`],
    ["base64 with wrong padding", `pid=7:time=${T}:argv=bnZpbQ=`],
    ["base64 with non-canonical trailing bits", `pid=7:time=${T}:argv=bnZpbR==`],
    ["decoded bytes that are not UTF-8", `pid=7:time=${T}:argv=${Buffer.from([0xff, 0xfe]).toString("base64")}`],
    ["a newline in an argument", `pid=7:time=${T}:argv=${b64("nvim")},${b64("a\nb")}`],
    ["a C1 control in the cwd", `pid=7:time=${T}:argv=${b64("nvim")}:cwd=${b64("/a\u0085b")}`],
    ["a pid of 0", `pid=0:time=${T}:argv=${b64("nvim")}`],
    ["no pid", `time=${T}:argv=${b64("nvim")}`],
    ["more elements than the limit", `pid=7:time=${T}:argv=${[b64("nvim"), ...Array(MAX_ARGV).fill("")].join(",")}`],
  ];
  for (const [what, rest] of cases) {
    test(what, () => {
      expect(verify(signed(rest))).toMatchObject({ kind: "rejected" });
    });
  }
  test("a pid too large to represent has no owner, so nothing is removed", () => {
    expect(verify(signed(`pid=${"9".repeat(30)}:time=${T}:argv=${b64("./x")}`))).toEqual({
      kind: "rejected",
      pid: undefined,
      why: expect.any(String),
    });
  });
});

const seq = (body: string, st = "\x1b\\"): string => `\x1b]7577;${body}${st}`;

describe("Osc7577Scanner", () => {
  test("finds a report ended by ST or BEL among other output and other OSCs", () => {
    const scanner = new Osc7577Scanner();
    const found = scanner.feed(bytes(`hello\x1b]7501;state=working\x07${seq(NVIM)}more${seq(LAZYGIT, "\x07")}`));
    expect(found.map((body) => new TextDecoder().decode(body))).toEqual([NVIM, LAZYGIT]);
  });

  test("a report split across chunks is found whole", () => {
    const scanner = new Osc7577Scanner();
    const whole = bytes(`x${seq(NVIM)}y`);
    const found: Uint8Array[] = [];
    for (let at = 0; at < whole.byteLength; at += 3) found.push(...scanner.feed(whole.subarray(at, at + 3)));
    expect(found.map((body) => new TextDecoder().decode(body))).toEqual([NVIM]);
  });

  test("a report cut short by another escape, CAN or SUB is dropped, and the next one is still found", () => {
    const scanner = new Osc7577Scanner();
    const found = scanner.feed(bytes(`\x1b]7577;pid=1\x1b[0m\x1b]7577;pid=2\x18\x1b]7577;pid=3\x1a${seq(NVIM)}`));
    expect(found.map((body) => new TextDecoder().decode(body))).toEqual([NVIM]);
  });

  test("a report longer than the limit is dropped whole, and the scanner recovers after its end", () => {
    const scanner = new Osc7577Scanner();
    const long = `pid=7:time=${T}:argv=${"A".repeat(MAX_REPORT_BYTES)}`;
    const found = scanner.feed(bytes(`${seq(long)}${seq(NVIM)}`));
    expect(found.map((body) => new TextDecoder().decode(body))).toEqual([NVIM]);
  });

  test("a report of exactly the limit, opener and ST included, is kept", () => {
    const scanner = new Osc7577Scanner();
    const filler = "A".repeat(MAX_REPORT_BYTES - "\x1b]7577;".length - 2);
    expect(scanner.feed(bytes(seq(filler)))).toHaveLength(1);
    expect(new Osc7577Scanner().feed(bytes(seq(`${filler}A`)))).toHaveLength(0);
  });

  test("OSC 75770 and OSC 757 are not OSC 7577", () => {
    const scanner = new Osc7577Scanner();
    expect(scanner.feed(bytes(`\x1b]75770;${NVIM}\x07\x1b]757;${NVIM}\x07`))).toHaveLength(0);
  });
});
