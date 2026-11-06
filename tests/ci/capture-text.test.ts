import { describe, expect, test } from "bun:test";
import { classify } from "./capture-text.ts";

describe("a capture's OCR text", () => {
  test("a neutral prompt and a plain directory pass", () => {
    expect(classify("demo@my-laptop:~/project$ bun test").ok).toBe(true);
    expect(classify("$ bun test\n12 pass").ok).toBe(true);
    expect(classify("> 1\nweb\nIdle").ok).toBe(true);
  });

  test("an account at a host says which pattern it trips, never the text", () => {
    const verdict = classify("someone@a-host:/srv/run/clone$ ls");
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((one) => one.pattern)).toContain("prompt: account@host");
    expect(JSON.stringify(verdict)).not.toContain("someone");
    expect(JSON.stringify(verdict)).not.toContain("a-host");
  });

  test("a home or run-root path alone is enough", () => {
    expect(classify("/Users/someone/project").findings.map((one) => one.pattern)).toContain("path: home directory");
    expect(classify("/srv/runs/x/clone").findings.map((one) => one.pattern)).toContain("path: run root");
  });

  test("an ssh target names a host", () => {
    expect(classify("ssh someone@a-host").findings.map((one) => one.pattern)).toContain("host: ssh target");
  });

  test("a product name in a mockup is not an identifier", () => {
    expect(classify("MacBook Pro\nSettings\nTheme Light").ok).toBe(true);
    expect(classify("http://127.0.0.1:50170/").ok).toBe(true);
  });
});
