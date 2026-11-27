import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRow, type Agent } from "./agent-row.tsx";

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: "t1",
  name: "worker",
  status: "working",
  ...extra,
});

describe("AgentRow", () => {
  test("draws a mark for named products and omits generic or unknown marks", () => {
    for (const kind of ["claude", "codex", "omo", "gemini"]) {
      const markup = renderToStaticMarkup(<AgentRow agent={agent({ kind })} />);
      expect(markup).toContain(`data-agent-mark="${kind}"`);
    }
    for (const kind of ["agent", "shell", "program", "unknown"]) {
      const markup = renderToStaticMarkup(<AgentRow agent={agent({ kind })} />);
      expect(markup).not.toContain("data-agent-mark=");
    }
  });

  test("omits age when it is '<1m' and draws every other age", () => {
    const fresh = renderToStaticMarkup(<AgentRow agent={agent({ age: "<1m" })} />);
    expect(fresh).not.toContain("<time");
    expect(fresh).not.toContain("&lt;1m");

    const absent = renderToStaticMarkup(<AgentRow agent={agent()} />);
    expect(absent).not.toContain("<time");

    for (const age of ["1m", "4m", "2h"]) {
      const markup = renderToStaticMarkup(<AgentRow agent={agent({ age })} />);
      expect(markup).toContain(`<time`);
      expect(markup).toContain(`>${age}</time>`);
    }
  });

  test("draws tree guides with 1px strokes in bg-dim", () => {
    const markup = renderToStaticMarkup(<AgentRow agent={agent({ depth: 2, guides: ["│", "└"] })} />);
    expect(markup).toContain("data-tree-guides");
    expect(markup).toContain("bg-dim");
    expect(markup).toContain("w-px");
    expect(markup).toContain("h-px");
    expect(markup).not.toContain("bg-border");
    expect(markup).not.toContain("1.5px");
  });
});
