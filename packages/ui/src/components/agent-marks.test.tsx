import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark } from "./agent-mark.tsx";
import { AGENT_MARKS, hasAgentMark } from "./agent-marks.ts";

const NOTICES = readFileSync(join(import.meta.dirname, "../../NOTICES.md"), "utf8");

const readAttr = (markup: string, attr: string): string | undefined =>
  new RegExp(`${attr}="([^"]*)"`).exec(markup)?.[1];

/** First-column keys from the markdown table in NOTICES.md (after the header and separator rows). */
function noticedKinds(markdown: string): string[] {
  const rows = markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "");
  return rows.filter((cell) => cell !== "" && cell !== "kind" && !/^-+$/u.test(cell));
}

describe("AGENT_MARKS", () => {
  test("every entry renders as an accessible single-colour img with its label and data-agent-mark", () => {
    const keys = Object.keys(AGENT_MARKS);
    expect(keys).toHaveLength(17);
    for (const [kind, entry] of Object.entries(AGENT_MARKS)) {
      const markup = renderToStaticMarkup(<AgentMark kind={kind} />);
      expect(readAttr(markup, "role")).toBe("img");
      expect(readAttr(markup, "aria-label")).toBe(entry.label);
      expect(readAttr(markup, "data-agent-mark")).toBe(kind);
      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(markup).not.toContain("rgb(");
      if (entry.from === "simple-icons") {
        expect(entry.path.length).toBeGreaterThan(0);
        // Simple Icons paths start with an SVG moveto command ("M" or relative initial "m", as in claude.svg).
        expect(entry.path).toMatch(/^[Mm]/u);
        expect(readAttr(markup, "fill")).toBe("currentColor");
      }
    }
  });

  test("a decorative mark has no name of its own: hidden from the accessibility tree, still found by its key", () => {
    for (const kind of ["claude", "codex"]) {
      const markup = renderToStaticMarkup(<AgentMark kind={kind} decorative />);
      expect(readAttr(markup, "aria-hidden")).toBe("true");
      expect(readAttr(markup, "role")).toBeUndefined();
      expect(readAttr(markup, "aria-label")).toBeUndefined();
      expect(readAttr(markup, "data-agent-mark")).toBe(kind);
    }
  });

  test("unknown kinds render nothing and hasAgentMark only accepts own keys", () => {
    for (const kind of Object.keys(AGENT_MARKS)) {
      expect(hasAgentMark(kind)).toBe(true);
    }
    expect(hasAgentMark("nope")).toBe(false);
    expect(hasAgentMark("toString")).toBe(false);
    expect(hasAgentMark(undefined)).toBe(false);
    expect(renderToStaticMarkup(<AgentMark kind="nope" />)).toBe("");
    expect(renderToStaticMarkup(<AgentMark kind="toString" />)).toBe("");
  });

  test("packages/ui/NOTICES.md lists every mark in AGENT_MARKS and no extra key", () => {
    const listed = noticedKinds(NOTICES);
    const expected = Object.keys(AGENT_MARKS);
    expect(listed.toSorted()).toEqual(expected.toSorted());
    expect(new Set(listed).size).toBe(expected.length);
  });
});
