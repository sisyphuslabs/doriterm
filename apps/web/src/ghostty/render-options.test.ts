import { describe, expect, test } from "bun:test";
import { EMPTY_CONFIG, withValues } from "./config.ts";
import { rendererOptions } from "./render-options.ts";

describe("Copy on selection", () => {
  test("is off for an untouched terminal config", () => {
    expect(rendererOptions(EMPTY_CONFIG).copyOnSelect).toBe(false);
  });

  test.each(["true", "clipboard"])("an explicit %s enables it, preserving imported Ghostty configs", (value) => {
    const config = withValues(EMPTY_CONFIG, "copy-on-select", [value]);
    expect(rendererOptions(config).copyOnSelect).toBe(true);
  });

  test("turning it off returns to the default", () => {
    const enabled = withValues(EMPTY_CONFIG, "copy-on-select", ["true"]);
    const disabled = withValues(enabled, "copy-on-select", ["false"]);
    expect(rendererOptions(disabled).copyOnSelect).toBe(false);
    expect(disabled.has("copy-on-select")).toBe(false);
  });
});
