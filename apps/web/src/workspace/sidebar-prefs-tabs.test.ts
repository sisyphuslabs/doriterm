import { expect, test } from "bun:test";
import { SidebarPrefsStore } from "./sidebar-prefs.ts";

/** One localStorage shared by two open tabs of the app. */
function shared(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

test("a colour one tab removed is not written back by another tab's later save (#2602)", () => {
  const storage = shared({
    "doriface.sidebar": JSON.stringify({ colors: { "space:m/s1": "teal", "space:m/s2": "blue" } }),
  });
  const one = new SidebarPrefsStore(storage);
  const two = new SidebarPrefsStore(storage);
  one.update({ colors: { "space:m/s2": "blue" } });
  two.update({ colors: { ...two.value.colors, "space:m/s3": "orange" } });
  const saved = JSON.parse(storage.getItem("doriface.sidebar") ?? "{}").colors;
  expect(saved).toEqual({ "space:m/s2": "blue", "space:m/s3": "orange" });
});
