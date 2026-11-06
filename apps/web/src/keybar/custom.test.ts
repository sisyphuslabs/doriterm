import { expect, test } from "bun:test";
import { MAX_TEXT_BYTES, parseKeyInput } from "./custom.ts";

const key = (input: string): { bytes: string; label: string } => {
  const parsed = parseKeyInput(input);
  if (parsed.kind === "error") throw new Error(`${input}: ${parsed.reason}`);
  return { bytes: parsed.key.bytes, label: parsed.key.label };
};

const reason = (input: string): string => {
  const parsed = parseKeyInput(input);
  if (parsed.kind === "ok") throw new Error(`${input} parsed as ${JSON.stringify(parsed.key)}`);
  return parsed.reason;
};

test.each([
  ["Ctrl+X", "\u0018"],
  ["ctrl+x", "\u0018"],
  ["Control+X", "\u0018"],
  ["^C", "\u0003"],
  ["Ctrl+?", "\u007f"],
  ["Ctrl+[", "\u001b"],
  ["Alt+X", "\u001bx"],
  ["Option+x", "\u001bx"],
  ["Meta+x", "\u001bx"],
  // A terminal has no Command: it reads as meta, the way the bar's own Cmd key does.
  ["Cmd+X", "\u001bx"],
  ["Shift+A", "A"],
  ["Ctrl+Shift+A", "\u0001"],
  ["Ctrl+Alt+Shift+B", "\u001b\u0002"],
  ["Tab", "\t"],
  ["Shift+Tab", "\u001b[Z"],
  ["Esc", "\u001b"],
  ["Enter", "\r"],
  ["Backspace", "\u007f"],
  ["Space", " "],
  ["Home", "\u001b[H"],
  ["End", "\u001b[F"],
  ["PgUp", "\u001b[5~"],
  ["PageDown", "\u001b[6~"],
  ["Del", "\u001b[3~"],
  ["Ins", "\u001b[2~"],
  ["F1", "\u001bOP"],
  ["F4", "\u001bOS"],
  ["F5", "\u001b[15~"],
  ["F12", "\u001b[24~"],
  ["Ctrl+F5", "\u001b[15;5~"],
  ["Ctrl+Left", "\u001b[1;5D"],
  ["Alt+Shift+Up", "\u001b[1;4A"],
  ["Ctrl+Home", "\u001b[1;5H"],
  ["git status", "git status"],
  ["+", "+"],
  ["-", "-"],
  ["*", "*"],
] as const)("%p sends %j", (input, bytes) => {
  expect(key(input)).toMatchObject({ bytes });
});

test("a chord's label is canonical, whatever case or order it was typed in", () => {
  expect(key("shift+ctrl+x").label).toBe("Ctrl+Shift+x");
  expect(key(" f5 ").label).toBe("F5");
  expect(key("PageUp").label).toBe("PgUp");
  expect(key("hello").label).toBe("hello");
});

test("an empty key, a dangling modifier and an unknown word after a modifier are refused with a reason", () => {
  expect(reason("")).toBe("Type the keys this key sends.");
  expect(reason("   ")).toBe("Type the keys this key sends.");
  expect(reason("Ctrl+")).toBe("End the key with what it presses, e.g. Ctrl+X.");
  expect(reason("Ctrl+foobar")).toContain("is not a key");
});

test.each(["Ctrl", "Control", "Shift", "Alt", "Option", "Cmd"])(
  "the bare word %p is refused rather than sent as text",
  (input) => {
    expect(reason(input)).toBe(`"${input}" on its own sends nothing; add the key it presses, e.g. ${input}+X.`);
  },
);

test.each([
  "1+1",
  "a + b",
  "C++",
  "x + y",
  "chmod +x",
  "date +%s",
  "echo $((2+3))",
  "ls | wc -l",
  "Hyper+X",
  "git status",
  "awk '{print $1+$2}'",
  "make -j4 && make install",
])("%p is not a chord, so it sends that text verbatim", (input) => {
  expect(key(input).bytes).toBe(input);
});

test("a modifier that would change nothing is refused instead of dropped", () => {
  expect(reason("Ctrl+Shift+Tab")).toBe("Ctrl does not change Tab.");
  expect(reason("Ctrl+Esc")).toBe("Ctrl does not change Esc.");
  expect(reason("Ctrl++")).toBe("Ctrl does not change +.");
  expect(reason("Ctrl+git status")).toContain("is not a key");
  expect(reason("Shift+7")).toBe("Shift does not change 7.");
});

test("text longer than a key may send is refused rather than truncated", () => {
  const long = "a".repeat(MAX_TEXT_BYTES + 1);
  expect(reason(long)).toBe(`A key sends at most ${MAX_TEXT_BYTES} characters.`);
  expect(key("a".repeat(MAX_TEXT_BYTES)).bytes).toHaveLength(MAX_TEXT_BYTES);
});

test("nothing a person types is evaluated: a shell line stays the bytes it is", () => {
  expect(key("$(rm -rf /)").bytes).toBe("$(rm -rf /)");
  expect(key("`id`").bytes).toBe("`id`");
});
