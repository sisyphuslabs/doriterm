/**
 * OSC 7577, the Program Resume Protocol (revision 0.5, 2026-11-25): finds reports in a terminal's output and checks
 * one against the terminal's token, in the spec's order. The mac and the time come first, and a report that fails
 * either is ignored: whoever sent it is unknown, so no record may change. Strict parsing comes after, and a report that
 * fails it is rejected, which removes its owner's records.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The longest whole sequence kept, `ESC ] 7577 ;` and the terminator included (the spec's minimum is 2048). */
export const MAX_REPORT_BYTES = 4096;
/** The most argv elements a report may carry (the spec's minimum is 64). */
export const MAX_ARGV = 128;
/** How far a report's `time` may be from this clock, either way, in seconds. */
export const TIME_WINDOW_S = 60;

export type Verdict =
  | { readonly kind: "ignored"; readonly why: string }
  | { readonly kind: "rejected"; readonly pid: number | undefined; readonly why: string }
  | {
      readonly kind: "report";
      readonly pid: number;
      readonly time: number;
      readonly argv: readonly string[];
      readonly cwd: string | undefined;
    }
  | { readonly kind: "clear"; readonly pid: number; readonly time: number };

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const OPENER = new TextEncoder().encode("\x1b]7577;");
/** Body bytes a sequence may hold: the limit less the opener and the longest terminator (ESC \). */
const MAX_BODY_BYTES = MAX_REPORT_BYTES - OPENER.byteLength - 2;

/**
 * Finds whole OSC 7577 bodies in a byte stream fed in chunks of any size. A sequence cut short (by another escape,
 * CAN or SUB) or longer than the limit is dropped whole: the terminal cannot verify what it did not receive whole.
 */
export class Osc7577Scanner {
  /** How many opener bytes have matched; OPENER.length means inside a body. */
  #matched = 0;
  #body: number[] = [];
  #overflow = false;
  /** An ESC inside the body: a backslash next ends the sequence, anything else cuts it short. */
  #escape = false;

  feed(chunk: Uint8Array): Uint8Array[] {
    const found: Uint8Array[] = [];
    for (const byte of chunk) {
      if (this.#matched < OPENER.byteLength) {
        this.#open(byte);
        continue;
      }
      if (this.#escape) {
        this.#escape = false;
        if (byte === 0x5c) this.#end(found);
        else this.#restart(byte);
        continue;
      }
      if (byte === BEL) this.#end(found);
      else if (byte === ESC) this.#escape = true;
      else if (byte === CAN || byte === SUB) this.#reset();
      else if (this.#body.length < MAX_BODY_BYTES) this.#body.push(byte);
      else this.#overflow = true;
    }
    return found;
  }

  #open(byte: number): void {
    if (byte === OPENER[this.#matched]) this.#matched += 1;
    else this.#matched = byte === ESC ? 1 : 0;
  }

  #end(found: Uint8Array[]): void {
    if (!this.#overflow) found.push(Uint8Array.from(this.#body));
    this.#reset();
  }

  /** The ESC that cut a body short may open the next sequence. */
  #restart(byte: number): void {
    this.#reset();
    this.#matched = 1;
    this.#open(byte);
  }

  #reset(): void {
    this.#matched = 0;
    this.#body = [];
    this.#overflow = false;
    this.#escape = false;
  }
}

const MAC_HEX = /^[0-9a-f]{64}$/;
const NUMBER = /^[1-9][0-9]*$/;
const PAIR = /^([a-z]+)=([A-Za-z0-9_.,+/=-]*)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Whether `text` holds a character a resume command may not carry (C0, DEL, C1). */
export function hasControl(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
/** Every key this terminal implements, so `need` may name any of them. */
const IMPLEMENTED: ReadonlySet<string> = new Set(["pid", "time", "mac", "argv", "cwd", "clear", "need"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function safeNumber(text: string | undefined): number | undefined {
  if (text === undefined || !NUMBER.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** The value of the one pair named `key`, or undefined when there is none or more than one. */
function only(pairs: readonly string[], key: string): string | undefined {
  const values = pairs.filter((pair) => pair.startsWith(`${key}=`)).map((pair) => pair.slice(key.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Checks one body against `token` at `nowS`. `lastTime` answers the time of the last report accepted for a pid, so an
 * earlier report cannot replace a later one inside the window.
 */
export function verifyReport(
  body: Uint8Array,
  token: string,
  nowS: number,
  lastTime: (pid: number) => number | undefined,
): Verdict {
  const text = Buffer.from(body).toString("latin1");
  if (text === "?") return { kind: "ignored", why: "a body of ? is reserved" };
  const at = text.lastIndexOf(":mac=");
  const mac = at === -1 ? "" : text.slice(at + 5);
  if (at <= 0 || !MAC_HEX.test(mac)) return { kind: "ignored", why: "the report does not end with a mac" };
  const signed = body.subarray(0, at);
  const expected = createHash("sha256").update(signed).update(`:${token}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return { kind: "ignored", why: "the mac does not match" };
  const pairs = text.slice(0, at).split(":");
  const time = safeNumber(only(pairs, "time"));
  if (time === undefined) return { kind: "ignored", why: "the report has no time to check" };
  if (Math.abs(nowS - time) > TIME_WINDOW_S) return { kind: "ignored", why: "the time is outside the window" };
  const claimed = safeNumber(only(pairs, "pid"));
  const last = claimed === undefined ? undefined : lastTime(claimed);
  if (last !== undefined && time < last) return { kind: "ignored", why: "the time is before the pid's last report" };
  return parse(pairs, claimed, time);
}

/** Strict parsing of a report whose mac and time held: any failure rejects it, naming its owner when it has one. */
function parse(pairs: readonly string[], pid: number | undefined, time: number): Verdict {
  const reject = (why: string): Verdict => ({ kind: "rejected", pid, why });
  const values = new Map<string, string>();
  for (const pair of pairs) {
    const match = PAIR.exec(pair);
    if (match === null) return reject(`a malformed pair: ${JSON.stringify(pair)}`);
    const [, key = "", value = ""] = match;
    if (values.has(key)) return reject(`the key ${key} repeats`);
    values.set(key, value);
  }
  if (pid === undefined) return reject("the report has no usable pid");
  const need = values.get("need");
  if (need !== undefined && need.split(",").some((key) => !IMPLEMENTED.has(key)))
    return reject(`need names a key this terminal does not implement: ${need}`);
  const argv = values.get("argv");
  const clear = values.get("clear");
  if ((argv === undefined) === (clear === undefined)) return reject("a report has exactly one of argv and clear");
  if (clear !== undefined) return clear === "1" ? { kind: "clear", pid, time } : reject("clear is not 1");
  const elements = (argv ?? "").split(",");
  if (elements.length > MAX_ARGV) return reject(`argv has more than ${MAX_ARGV} elements`);
  const decoded: string[] = [];
  for (const element of elements) {
    const text = decodeText(element);
    if (text === undefined) return reject("an argv element is not base64 of UTF-8 text without controls");
    decoded.push(text);
  }
  const program = decoded[0] ?? "";
  if (program === "") return reject("the first argv element is empty");
  if (!program.startsWith("/") && (program.includes("/") || program.startsWith("-")))
    return reject("the first argv element is neither a bare command name nor an absolute path");
  const cwdValue = values.get("cwd");
  const cwd = cwdValue === undefined ? undefined : decodeText(cwdValue);
  if (cwdValue !== undefined && (cwd === undefined || !cwd.startsWith("/")))
    return reject("cwd is not base64 of an absolute path");
  return { kind: "report", pid, time, argv: decoded, cwd };
}

/** Standard base64 of UTF-8 text with no control character; padding optional, but correct when present. */
function decodeText(value: string): string | undefined {
  if (!BASE64.test(value)) return undefined;
  const bare = value.replace(/=+$/, "");
  if (bare.length % 4 === 1 || (bare.length !== value.length && value.length % 4 !== 0)) return undefined;
  const bytes = Buffer.from(bare, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== bare) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  return hasControl(text) ? undefined : text;
}
