import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_BAD, PLACEHOLDERS } from "./capture-text-fixtures.ts";
import { captureText, classify } from "./capture-text.ts";

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
    expect(patterns("alpha@build.acme.dev:~$ ls")).toContain("prompt: account at host");
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

describe("the known-bad list", () => {
  test.each(KNOWN_BAD)("flags $why", ({ text }) => {
    expect(classify(text).ok).toBe(false);
  });
});

describe("the placeholder list", () => {
  test.each(PLACEHOLDERS)("passes $why", ({ text }) => {
    expect(classify(text)).toEqual({ ok: true, findings: [] });
  });
});

const REPO = join(import.meta.dirname, "..", "..");

describe("the Capture text workflow starts", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(REPO, ".github/workflows/capture-text.yml"), "utf8")) as {
    on: { pull_request: { paths: string[] } };
  };
  const globs = workflow.on.pull_request.paths.map((pattern) => new Bun.Glob(pattern));
  const starts = (path: string): boolean => globs.some((glob) => glob.match(path));

  test("for an image under docs/ or .github/assets in any case of its extension", () => {
    for (const ext of ["png", "Png", "PNG", "jpg", "Jpeg", "webp", "gif", "GIF", "svg", "Svg"]) {
      expect({ ext, starts: starts(`docs/design/app/a.${ext}`) }).toEqual({ ext, starts: true });
      expect({ ext, starts: starts(`.github/assets/a.${ext}`) }).toEqual({ ext, starts: true });
    }
    expect(starts("docs/design/notes.md")).toBe(false);
  });

  test("for a change to any file of the check, the known-bad list included", () => {
    for (const path of [
      "tests/ci/capture-text.ts",
      "tests/ci/capture-text.test.ts",
      "tests/ci/capture-text-fixtures.ts",
    ]) {
      expect({ path, starts: starts(path) }).toEqual({ path, starts: true });
    }
  });
});

/** An SVG is written out and read back through captureText, the way the workflow reads a committed one. */
async function captureSvg(markup: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "capture-text-"));
  try {
    const svg = join(dir, "a.svg");
    writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`);
    return await captureText(svg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("an SVG's own text is checked, since OCR cannot read one", () => {
  test("a prompt in one text node is found, and a placeholder is spared", async () => {
    expect(patterns(await captureSvg('<text x="1">someone@alpha-box:~$ ls</text>'))).toContain(
      "prompt: account at host",
    );
    expect(classify(await captureSvg('<text x="1">demo@my-laptop:~$ ls</text>')).ok).toBe(true);
  });

  test("a prompt split across tspans is joined, since a separator would hide it", async () => {
    expect(patterns(await captureSvg('<text x="1">someone@<tspan>alpha-box</tspan>:~$ ls</text>'))).toContain(
      "prompt: account at host",
    );
  });

  test("separate text elements stay separate lines, so a minified SVG's clean lines do not run together", async () => {
    expect(classify(await captureSvg('<text x="1">$ ls</text><text x="1">demo@my-laptop:~$ ls</text>')).ok).toBe(true);
  });

  test("a prompt in a CDATA section is read, not dropped", async () => {
    expect(patterns(await captureSvg('<text x="1"><![CDATA[someone@alpha-box:~$ ls]]></text>'))).toContain(
      "prompt: account at host",
    );
  });

  test("a prompt written with an entity is decoded to what a renderer shows", async () => {
    expect(patterns(await captureSvg('<text x="1">someone&#64;alpha-box:~$ ls</text>'))).toContain(
      "prompt: account at host",
    );
    expect(patterns(await captureSvg('<text x="1">someone&#x40;alpha-box:~$ ls</text>'))).toContain(
      "prompt: account at host",
    );
  });

  test("a split or encoded placeholder still names no one", async () => {
    expect(classify(await captureSvg('<text x="1">you@<tspan>example.com</tspan></text>')).ok).toBe(true);
    expect(classify(await captureSvg('<text x="1">you&#64;example.com</text>')).ok).toBe(true);
  });

  test("every XML entity decodes, and an entity-encoded bracket stays text", async () => {
    expect(await captureSvg("<text>&amp; &lt; &gt; &quot; &apos;</text>")).toContain("& < > \" '");
  });
});
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
