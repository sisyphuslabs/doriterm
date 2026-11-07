import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { KEYMAP_VERSION, KeymapStore } from "./keymap-store.ts";
import {
  actionKeys,
  checkBinding,
  resetAction,
  resolveKeymap,
  triggersFor,
  withBinding,
  withoutTrigger,
} from "./keymap.ts";
import { normalizeTrigger, triggerFromEvent } from "./trigger.ts";

describe("actionKeys", () => {
  test("the palette hint follows the platform", () => {
    expect(actionKeys(resolveKeymap("mac", new Map()), "app.palette", "mac")).toEqual(["⇧", "⌘", "P"]);
    expect(actionKeys(resolveKeymap("other", new Map()), "app.palette", "other")).toEqual(["Ctrl", "Shift", "P"]);
  });

  test("the palette hint follows a rebind and disappears once unbound", () => {
    const moved = withBinding("mac", new Map(), normalizeTrigger("super+k") ?? "", "app.palette");
    const rebound = resolveKeymap("mac", withoutTrigger("mac", moved, normalizeTrigger("super+shift+p") ?? ""));
    expect(actionKeys(rebound, "app.palette", "mac")).toEqual(["⌘", "K"]);
    const unbound = resolveKeymap("mac", withoutTrigger("mac", new Map(), normalizeTrigger("super+shift+p") ?? ""));
    expect(actionKeys(unbound, "app.palette", "mac")).toBeUndefined();
  });
});

describe("resolveKeymap", () => {
  test("defaults differ per platform and overrides win", () => {
    expect(resolveKeymap("mac", new Map()).get("super+t")).toBe("tab.new");
    expect(resolveKeymap("other", new Map()).get("ctrl+shift+t")).toBe("tab.new");
    const keymap = resolveKeymap(
      "mac",
      new Map([
        ["super+t", "tab.close"],
        ["super+w", null],
      ]),
    );
    expect(keymap.get("super+t")).toBe("tab.close");
    expect(keymap.has("super+w")).toBe(false);
  });

  test("⌘⇧P (ctrl+shift+p off macOS) opens the command palette by default", () => {
    expect(resolveKeymap("mac", new Map()).get(normalizeTrigger("super+shift+p") ?? "")).toBe("app.palette");
    expect(resolveKeymap("other", new Map()).get(normalizeTrigger("ctrl+shift+p") ?? "")).toBe("app.palette");
  });

  test("a changed default never overwrites an override", () => {
    const overrides = withBinding("mac", new Map(), "super+t", "tab.close");
    const shipped = resolveKeymap("mac", new Map());
    const changedDefaults = new Map([...shipped, ["super+t", "pane.split:right"], ["super+shift+y", "agent.next"]]);
    const resolved = resolveKeymap("mac", overrides, changedDefaults);
    expect(resolved.get("super+t")).toBe("tab.close");
    expect(resolved.get("super+shift+y")).toBe("agent.next");
  });

  test("removals are stored explicitly and reset forgets them", () => {
    const removed = withoutTrigger("mac", new Map(), "super+t");
    expect(removed.get("super+t")).toBeNull();
    expect(triggersFor(resolveKeymap("mac", removed), "tab.new")).toEqual([]);
    expect(resetAction("mac", removed, "tab.new").size).toBe(0);
    expect(withoutTrigger("mac", new Map([["super+shift+n", "tab.new"]]), "super+shift+n").size).toBe(0);
  });
});

/** AltGr+= as Windows reports it: Ctrl and Alt held, AltGraph on, typing `key`. */
const altGr = (key: string) => ({
  code: "Equal",
  key,
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  getModifierState: (state: string) => state === "AltGraph",
});

describe("triggers", () => {
  test.each([
    ["cmd+shift+T", "shift+super+t"],
    ["ctrl++", "ctrl+shift+="],
    ["Ctrl+Shift+PageDown", "ctrl+shift+page_down"],
    ["super", null],
    ["ctrl+nope", null],
    ["ctrl+++", null],
    ["++", "shift+="],
  ])("%p -> %p", (text, expected) => expect(normalizeTrigger(text)).toBe(expected));

  test("herdr-app's dash syntax", () => {
    expect(normalizeTrigger("cmd-alt-shift-left", true)).toBe("alt+shift+super+left");
    expect(normalizeTrigger("ctrl--", true)).toBe("ctrl+-");
    expect(normalizeTrigger("ctrl---", true)).toBeNull();
  });

  test("key events use layout-independent codes", () => {
    const event = { code: "KeyT", ctrlKey: false, altKey: false, shiftKey: true, metaKey: true };
    expect(triggerFromEvent(event)).toBe("shift+super+t");
    expect(triggerFromEvent({ ...event, code: "ShiftLeft" })).toBeNull();
    expect(triggerFromEvent({ ...event, code: "F12" })).toBe("shift+super+f12");
    expect(triggerFromEvent({ ...event, code: "F13" })).toBeNull();
  });

  // Windows reports AltGr as Ctrl+Alt: on AZERTY, AltGr+= types `}` and must reach the terminal, not ctrl+alt+= (#403).
  test("a character typed through AltGr is no trigger, while the same keys without AltGr still are", () => {
    expect(triggerFromEvent(altGr("}"))).toBeNull();
    expect(triggerFromEvent({ ...altGr("="), getModifierState: () => false })).toBe("ctrl+alt+=");
    expect(triggerFromEvent({ ...altGr("}"), metaKey: true })).toBe("ctrl+alt+super+=");
  });
});

describe("KeymapStore", () => {
  test("custom keys saved before herdr-app's defaults arrived (#702) load as saved and keep winning over them", async () => {
    const storage = memoryStore();
    const saved = {
      version: KEYMAP_VERSION,
      bindings: [
        ["super+w", "pane.close"],
        ["ctrl+1", "space.select:1"],
        ["shift+super+r", null],
      ],
    };
    await storage.put("keymap", saved);
    const store = new KeymapStore(storage);
    await store.loaded;
    expect(await storage.get("keymap")).toEqual(saved);
    const mac = resolveKeymap("mac", store.overrides);
    expect([mac.get("super+w"), mac.has("shift+super+r")]).toEqual(["pane.close", false]);
    expect(resolveKeymap("other", store.overrides).get("ctrl+1")).toBe("space.select:1");
  });

  test("a binding whose action this build does not know is kept in storage through an unrelated edit", async () => {
    const storage = memoryStore();
    await storage.put("keymap", {
      version: KEYMAP_VERSION,
      bindings: [
        ["super+j", "pane.future"],
        ["super+k", "tab.new"],
      ],
    });
    const store = new KeymapStore(storage);
    await store.loaded;
    expect([...store.overrides]).toEqual([["super+k", "tab.new"]]);
    await store.update((current) => new Map([...current, ["ctrl+alt+x", "tab.close"]]));
    expect(await storage.get("keymap")).toEqual({
      version: KEYMAP_VERSION,
      bindings: [
        ["super+k", "tab.new"],
        ["ctrl+alt+x", "tab.close"],
        ["super+j", "pane.future"],
      ],
    });
  });

  test("a key this build binds again replaces the unknown action saved on it", async () => {
    const storage = memoryStore();
    await storage.put("keymap", { version: KEYMAP_VERSION, bindings: [["super+j", "pane.future"]] });
    const store = new KeymapStore(storage);
    await store.update((current) => new Map([...current, ["super+j", "tab.close"]]));
    expect(await storage.get("keymap")).toEqual({ version: KEYMAP_VERSION, bindings: [["super+j", "tab.close"]] });
  });

  test("a key this build binds again replaces the unknown action saved on it under another spelling of that key", async () => {
    const storage = memoryStore();
    await storage.put("keymap", { version: KEYMAP_VERSION, bindings: [["Alt+Super+J", "pane.future"]] });
    const store = new KeymapStore(storage);
    const key = checkBinding("super+alt+j", null);
    if (!key.ok) throw new Error(key.reason);
    await store.update((current) => new Map([...current, [key.trigger, "tab.close"]]));
    expect(await storage.get("keymap")).toEqual({ version: KEYMAP_VERSION, bindings: [[key.trigger, "tab.close"]] });
  });

  test("a keymap saved before split down arrived reads split as split right, once, and is saved at this version", async () => {
    const storage = memoryStore();
    const old = { version: 1, bindings: [["super+k", "pane.split"]] };
    await storage.put("keymap", old);
    const store = new KeymapStore(storage);
    await store.loaded;
    expect([...store.overrides]).toEqual([["super+k", "pane.split:right"]]);
    expect(KEYMAP_VERSION).toBeGreaterThan(1);
    expect(await storage.get("keymap")).toEqual({
      version: KEYMAP_VERSION,
      bindings: [["super+k", "pane.split:right"]],
    });
    expect(await storage.get("keymap.backup.v1")).toEqual(old);
  });

  test("a keymap a newer build saved is never rewritten by this one", async () => {
    const storage = memoryStore();
    const newer = { version: KEYMAP_VERSION + 1, bindings: [["super+j", "pane.future"]] };
    await storage.put("keymap", newer);
    const store = new KeymapStore(storage);
    await store.update((current) => new Map([...current, ["ctrl+alt+x", "tab.close"]]));
    expect(await storage.get("keymap")).toEqual(newer);
    expect(store.error?.message).toContain("newer");
  });

  test("refuses an invalid write and keeps what it had", async () => {
    const store = new KeymapStore(memoryStore());
    await store.loaded;
    const kept = new Map([["shift+super+n", "tab.new"]]);
    await store.update(() => kept);
    await expect(store.update(() => new Map([["super", "tab.new"]]))).rejects.toThrow("not a key combination");
    await expect(store.update(() => new Map([["super+t", "nope"]]))).rejects.toThrow("not an action");
    expect(store.overrides).toEqual(kept);
    expect(checkBinding("super+t", null).ok).toBe(true);
  });

  test("a binding made before the stored keymap loads applies on top of it", async () => {
    const gate = Promise.withResolvers<void>();
    const stored = {
      version: KEYMAP_VERSION,
      bindings: [
        ["shift+super+n", "tab.new"],
        ["super+t", null],
      ],
    };
    const puts: unknown[] = [];
    const store = new KeymapStore({
      get: async () => (await gate.promise, stored),
      put: async (_k, v) => void puts.push(v),
    });
    const early = store.update((current) => new Map([...current, ["ctrl+alt+x", "tab.close"]]));
    gate.resolve();
    await early;
    expect([...store.overrides]).toEqual([
      ["shift+super+n", "tab.new"],
      ["super+t", null],
      ["ctrl+alt+x", "tab.close"],
    ]);
    expect(puts.at(-1)).toEqual({ version: KEYMAP_VERSION, bindings: [...store.overrides] });
  });

  test("after a failed read, an update never overwrites the stored keymap", async () => {
    const puts: unknown[] = [];
    const store = new KeymapStore({
      get: async () => {
        throw new Error("IndexedDB read failed");
      },
      put: async (_key, value) => void puts.push(value),
    });
    await store.update((current) => new Map([...current, ["ctrl+alt+x", "tab.close"]]));
    expect(puts).toEqual([]);
    expect(store.error?.message).toBe("IndexedDB read failed");
    expect(store.overrides.size).toBe(0);
  });

  test("a failed migration lets no later update apply on an empty snapshot", async () => {
    const old = { version: 0, bindings: [["super+shift+n", "tab.new"]] };
    const puts: unknown[] = [];
    const store = new KeymapStore({
      get: async () => old,
      put: async (key, value) => {
        if (key.startsWith("keymap.backup")) throw new Error("backup write failed");
        puts.push(value);
      },
    });
    await store.update((current) => new Map([...current, ["ctrl+alt+x", "tab.close"]]));
    await store.update((current) => new Map([...current, ["ctrl+alt+y", "tab.new"]]));
    expect(puts).toEqual([]);
    expect(store.error?.message).toBe("backup write failed");
  });

  test("a keymap from a newer build is left untouched", async () => {
    const storage = memoryStore();
    const newer = { version: KEYMAP_VERSION + 1, bindings: [["super+shift+n", "tab.new"]] };
    await storage.put("keymap", newer);
    const store = new KeymapStore(storage);
    await store.loaded;
    expect(store.overrides.size).toBe(0);
    expect(await storage.get("keymap")).toEqual(newer);
  });

  test("backs up an older version before migrating it", async () => {
    const storage = memoryStore();
    await storage.put("keymap", {
      version: 0,
      bindings: [
        ["super+shift+n", "tab.new"],
        ["bad", "tab.new"],
      ],
    });
    const store = new KeymapStore(storage);
    await store.loaded;
    expect(store.overrides.get("shift+super+n")).toBe("tab.new");
    expect(store.overrides.size).toBe(1);
    expect(await storage.get("keymap.backup.v0")).toEqual({
      version: 0,
      bindings: [
        ["super+shift+n", "tab.new"],
        ["bad", "tab.new"],
      ],
    });
    expect(await storage.get("keymap")).toEqual({ version: KEYMAP_VERSION, bindings: [["shift+super+n", "tab.new"]] });
  });
});
