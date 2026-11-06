import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classify } from "./capture-text.ts";

const patterns = (text: string): string[] => classify(text).findings.map((one) => one.pattern);

describe("a capture's OCR text", () => {
  test("a neutral prompt, home and ssh target pass", () => {
    expect(classify("demo@my-laptop:~/project$ bun test").ok).toBe(true);
    expect(classify("demo@my-laptop ~ % ls").ok).toBe(true);
    expect(classify("/home/demo/project").ok).toBe(true);
    expect(classify("ssh demo@my-laptop").ok).toBe(true);
    expect(classify("user@localhost:~$ ls").ok).toBe(true);
  });

  test("a capitalised account or host is still an account at a host", () => {
    expect(patterns("User@Users-MacBook-Pro ~ % ls")).toContain("prompt: account at host");
    expect(patterns("Alice@build-box:~$ ls")).toContain("prompt: account at host");
  });

  test("a named host is flagged even when the host word is neutral", () => {
    expect(patterns("someone@localhost:~$ ls")).toContain("prompt: account at host");
    expect(patterns("someone@my-laptop:~$ ls")).toContain("prompt: account at host");
    expect(classify("demo@localhost:~$ ls").ok).toBe(true);
  });

  test("package specs and registry hosts are not accounts on a computer", () => {
    expect(classify("bunx playwright@latest").ok).toBe(true);
    expect(classify("git@github.com:owner/repo.git").ok).toBe(true);
    expect(classify("e@me").ok).toBe(true);
  });

  test("a zsh-style prompt names an account and a host without a colon", () => {
    expect(patterns("alpha-center@build-box ~ % ls")).toContain("prompt: account at host");
  });

  test("a fully qualified host is a host", () => {
    expect(patterns("alpha@build.example.com:~$ ls")).toContain("prompt: account at host");
  });

  test("an account at a host says which shape it trips, never the text", () => {
    const verdict = classify("someone@alpha-box:/srv/run/clone$ ls");
    expect(verdict.findings.map((one) => one.pattern)).toContain("prompt: account at host");
    expect(JSON.stringify(verdict)).not.toContain("someone");
    expect(JSON.stringify(verdict)).not.toContain("alpha-box");
  });

  test("a home or run-root path alone is enough, and a package root is not", () => {
    expect(patterns("/Users/someone/project")).toContain("path: home directory");
    expect(patterns("/srv/runs/x/clone")).toContain("path: run root");
    expect(patterns("/var/folders/xy/abc/T/x")).toContain("path: run root");
    expect(patterns("/tmp/x/clone")).toContain("path: run root");
    expect(classify("/opt/homebrew/bin/bun").ok).toBe(true);
  });

  test("a host name shown only as a UI label is out of scope, and a heading is never a finding", () => {
    expect(classify("Spaces\nmy-laptop this machine\n1").ok).toBe(true);
    expect(classify("Spaces\nConnect\nthis machine\n1").ok).toBe(true);
    expect(classify("Spaces\nalpha-box this machine\n1").ok).toBe(true);
  });

  test("a product name in a mockup is not an identifier", () => {
    expect(classify("MacBook Pro\nSettings\nTheme Light").ok).toBe(true);
    expect(classify("http://127.0.0.1:50170/").ok).toBe(true);
  });
});

const REPO = join(import.meta.dirname, "..", "..");
const tesseract = ((): string | undefined => {
  try {
    return execFileSync("sh", ["-lc", "command -v tesseract"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();

describe.skipIf(tesseract === undefined)("the committed captures raise no false alarm", () => {
  const samples = [
    "docs/design/app/settings-1440-day.png",
    "docs/design/app/sidebar-recompose-light-1440.png",
    "docs/design/app/pane-drop-1440-day.png",
  ].filter((path) => existsSync(join(REPO, path)));

  test("every sampled capture passes, so a clean image is never blocked", () => {
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const text = execFileSync(tesseract as string, [join(REPO, sample), "-"], { encoding: "utf8" });
      expect({ sample, findings: classify(text).findings }).toEqual({ sample, findings: [] });
    }
  });
});
