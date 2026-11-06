import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LEGACY_STORAGE_DIR, storageDirToPin } from "../src/config/storage.ts";

describe("where the app keeps its storage", () => {
  test("pins the folder installs already use, so a renamed app keeps its paired device and settings", () => {
    expect(storageDirToPin("/app-data", false)).toBe(join("/app-data", "doriface"));
    expect(LEGACY_STORAGE_DIR).toBe("doriface");
  });

  test("leaves a named profile alone, so --user-data-dir still selects its own folder", () => {
    expect(storageDirToPin("/app-data", true)).toBeUndefined();
  });
});
