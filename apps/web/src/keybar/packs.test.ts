import { expect, test } from "bun:test";
import { FAVORITES_PACK_ID, isPackId, PACKS, pack } from "./packs.ts";

const TMUX: Readonly<Record<string, string>> = {
  "tmux-prefix": "\u0002",
  "tmux-new": "\u0002c",
  "tmux-next": "\u0002n",
  "tmux-previous": "\u0002p",
  "tmux-split": "\u0002%",
  "tmux-split-down": '\u0002"',
  "tmux-list": "\u0002w",
  "tmux-zoom": "\u0002z",
  "tmux-detach": "\u0002d",
};

const AGENT: Readonly<Record<string, string>> = {
  "agent-escape": "\u001b",
  "agent-shift-tab": "\u001b[Z",
  "agent-interrupt": "\u0003",
  "agent-clear": "\u000c",
  "agent-exit": "\u0004",
  "agent-enter": "\r",
  "agent-yes": "y",
  "agent-no": "n",
};

const NAVIGATION: Readonly<Record<string, string>> = {
  "nav-home": "\u001b[H",
  "nav-end": "\u001b[F",
  "nav-pageup": "\u001b[5~",
  "nav-pagedown": "\u001b[6~",
  "nav-delete": "\u001b[3~",
  "nav-left": "\u001b[D",
  "nav-up": "\u001b[A",
  "nav-down": "\u001b[B",
  "nav-right": "\u001b[C",
};

const PACKED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  tmux: TMUX,
  agent: AGENT,
  navigation: NAVIGATION,
};

test.each(Object.entries(PACKED))("the %p pack sends exactly its table", (id, table) => {
  const keys = pack(id)?.keys ?? [];
  expect(keys.map((entry) => [entry.id, entry.bytes])).toEqual(Object.entries(table));
});

test("every pack entry is one the table names, and every named one is in its pack", () => {
  for (const [id, table] of Object.entries(PACKED)) {
    expect(
      pack(id)
        ?.keys.map((entry) => entry.id)
        .toSorted(),
    ).toEqual(Object.keys(table).toSorted());
  }
});

test("the ctrl chords pack is every control letter, A to Z, one byte each", () => {
  const keys = pack("ctrl-chords")?.keys ?? [];
  expect(keys).toHaveLength(26);
  expect(keys[0]).toMatchObject({ id: "ctrl-a", label: "^A", name: "Control A", bytes: "\u0001" });
  expect(keys[25]).toMatchObject({ id: "ctrl-z", label: "^Z", name: "Control Z", bytes: "\u001a" });
  expect(keys.map((entry) => entry.bytes)).toEqual(
    Array.from({ length: 26 }, (_, index) => String.fromCharCode(1 + index)),
  );
});

test("every pack has a name and a description, and its keys have spoken names", () => {
  for (const entry of PACKS) {
    expect([entry.id, entry.name.length > 0, entry.description.length > 0]).toEqual([entry.id, true, true]);
    for (const key of entry.keys) {
      expect([key.id, key.name.length > 0, key.bytes.length > 0, key.label.length > 0]).toEqual([
        key.id,
        true,
        true,
        true,
      ]);
    }
  }
});

test("no pack entry id is shared across packs, so a bar key always names one key", () => {
  const ids = PACKS.flatMap((entry) => entry.keys.map((key) => key.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test("a tab may name a built-in pack or Favorites, and nothing else", () => {
  expect(isPackId("tmux")).toBe(true);
  expect(isPackId(FAVORITES_PACK_ID)).toBe(true);
  expect(isPackId("nope")).toBe(false);
  expect(pack(FAVORITES_PACK_ID)).toBeUndefined();
});
