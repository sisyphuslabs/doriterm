import { expect, test } from "bun:test";
import { DEFAULT_KEY_IDS, SPECIAL_KEYS, specialKey, specialKeysOn } from "./catalog.ts";
import { keySequence } from "../terminal/keys.ts";

const BYTES: Readonly<Record<string, string>> = {
  tab: "\t",
  esc: "\u001b",
  interrupt: "\u0003",
  enter: "\r",
  backspace: "\u007f",
  clear: "\u000c",
  left: "\u001b[D",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  delete: "\u001b[3~",
  tilde: "~",
  pipe: "|",
  slash: "/",
  dash: "-",
};

const MODIFIER_IDS = ["ctrl", "cmd", "shift", "alt"];

test.each(Object.entries(BYTES))("the %p key sends %j", (id, bytes) => {
  expect(keySequence(id)).toBe(bytes);
});

test.each(MODIFIER_IDS)("the %p key is a modifier: it sends nothing and latches the next key", (id) => {
  expect(specialKey(id)).toBeDefined();
  expect(keySequence(id)).toBeUndefined();
});

test("every special key either sends bytes or is one of the four modifiers", () => {
  for (const entry of SPECIAL_KEYS) {
    const sends = keySequence(entry.id) !== undefined;
    expect([entry.id, sends || MODIFIER_IDS.includes(entry.id)]).toEqual([entry.id, true]);
  }
});

test("each key has a label and a spoken name, and no two share an id", () => {
  const ids = SPECIAL_KEYS.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of SPECIAL_KEYS) {
    expect([entry.id, entry.label.length > 0, entry.name.length > 0]).toEqual([entry.id, true, true]);
  }
});

test("the command key is offered on a Mac host only", () => {
  expect(specialKeysOn("mac").map((entry) => entry.id)).toContain("cmd");
  expect(specialKeysOn("other").map((entry) => entry.id)).not.toContain("cmd");
});

const defaultRowOn = (host: "mac" | "other"): readonly string[] => {
  const allowed = new Set(specialKeysOn(host).map((entry) => entry.id));
  return DEFAULT_KEY_IDS.filter((id) => allowed.has(id)).map((id) => specialKey(id)?.name ?? id);
};

test("the default bar opens on Escape and the same next keys on either host: no gap where a host has no Command", () => {
  // Escape leads, so it stays in view beside the fixed arrows (#2604). A Mac hides nothing, so its row goes on Control,
  // Command; a Linux host has no Command key, and the next real key fills its place rather than Option taking the slot.
  expect(defaultRowOn("mac").slice(0, 3)).toEqual(["Escape", "Control", "Command"]);
  expect(defaultRowOn("other").slice(0, 3)).toEqual(["Escape", "Control", "Shift"]);
});

test("the default bar is Escape, the modifiers through ^C and Enter (#1551), then the keys behind the old swipe: the arrows sit fixed beside the keyboard toggle instead (#2604)", () => {
  expect(DEFAULT_KEY_IDS).toEqual([
    "esc",
    "ctrl",
    "cmd",
    "shift",
    "tab",
    "alt",
    "interrupt",
    "enter",
    "tilde",
    "pipe",
    "slash",
    "dash",
  ]);
  for (const id of DEFAULT_KEY_IDS) expect([id, specialKey(id) !== undefined]).toEqual([id, true]);
});

test("the four arrows carry their glyph instead of a text label", () => {
  expect(specialKey("left")?.icon).toBe("left");
  expect(specialKey("up")?.icon).toBe("up");
  expect(specialKey("down")?.icon).toBe("down");
  expect(specialKey("right")?.icon).toBe("right");
  expect(specialKey("esc")?.icon).toBeNull();
});
