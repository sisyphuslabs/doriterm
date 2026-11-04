import { expect, test } from "bun:test";
import { applyModifiers, hostPlatform, keySequence } from "./keys.ts";

const latched = (...ids: string[]): ReadonlySet<string> => new Set(ids);

test.each([
  ["esc", "\u001b"],
  ["tab", "\t"],
  ["enter", "\r"],
  ["backspace", "\u007f"],
  ["clear", "\u000c"],
  ["up", "\u001b[A"],
  ["down", "\u001b[B"],
  ["right", "\u001b[C"],
  ["left", "\u001b[D"],
  ["tilde", "~"],
  ["pipe", "|"],
  ["slash", "/"],
  ["dash", "-"],
] as const)("the %p key sends %j", (id, bytes) => {
  expect(keySequence(id)).toBe(bytes);
});

test.each([
  ["c", ["ctrl"], "\u0003"],
  ["C", ["ctrl"], "\u0003"],
  ["[", ["ctrl"], "\u001b"],
  ["?", ["ctrl"], "\u007f"],
  [" ", ["ctrl"], "\u0000"],
  ["a", ["shift"], "A"],
  ["\t", ["shift"], "\u001b[Z"],
  ["x", ["alt"], "\u001bx"],
  ["x", ["cmd"], "\u001bx"],
  // A modified arrow carries the xterm modifier parameter: 1 + shift 1 + alt 2 + ctrl 4.
  ["\u001b[A", ["shift"], "\u001b[1;2A"],
  ["\u001b[B", ["alt"], "\u001b[1;3B"],
  ["\u001b[D", ["ctrl"], "\u001b[1;5D"],
  ["\u001b[C", ["ctrl", "shift"], "\u001b[1;6C"],
  ["\u001b[A", ["ctrl", "shift", "alt"], "\u001b[1;8A"],
  ["ls", [], "ls"],
  ["\u001b[A", [], "\u001b[A"],
  ["\r", ["shift"], "\r"],
] as const)("%j with %p latched sends %j", (data, mods, bytes) => {
  expect(applyModifiers(data, latched(...mods), "other")).toEqual({ kind: "write", data: bytes });
});

test("the paste chord of the host's platform pastes the device clipboard", () => {
  expect(applyModifiers("v", latched("cmd"), "mac")).toEqual({ kind: "paste" });
  expect(applyModifiers("V", latched("ctrl"), "other")).toEqual({ kind: "paste" });
  // On a mac host ctrl+v stays the terminal's literal-next.
  expect(applyModifiers("v", latched("ctrl"), "mac")).toEqual({ kind: "write", data: "\u0016" });
});

test.each([
  ["buildMac", "mac"],
  ["Alexs-MacBook-Pro.local", "mac"],
  ["Mac-mini", "mac"],
  ["studio iMac", "mac"],
  ["darwin-box", "mac"],
  ["machine", "other"],
  ["emacs-dev", "other"],
  ["ubuntu-server", "other"],
] as const)("a core named %p is a %p host", (name, platform) => {
  expect(hostPlatform(name)).toBe(platform);
});
