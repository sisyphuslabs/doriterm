import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFold } from "./agent-fold.tsx";
import { AGENT_TREE_DISCLOSURE_PX, AGENT_TREE_GUIDE_PX, agentRowLead } from "./agent-row.tsx";

const noop = (): void => {};

const readAttr = (markup: string, attr: string): string | undefined =>
  new RegExp(`${attr}="([^"]*)"`).exec(markup)?.[1];

describe("agentRowLead", () => {
  test("starts at the row's 8 px left pad and steps 14 px per level up to depthCap", () => {
    expect(AGENT_TREE_GUIDE_PX).toBe(14);
    expect(AGENT_TREE_DISCLOSURE_PX).toBe(18);
    expect(agentRowLead(0, 3)).toBe(8);
    expect(agentRowLead(1, 3)).toBe(22);
    expect(agentRowLead(2, 3)).toBe(36);
    expect(agentRowLead(3, 3)).toBe(50);
    expect(agentRowLead(4, 3)).toBe(50);
    expect(agentRowLead(3, 2)).toBe(36);
  });
});

describe("AgentFold accessible names and state", () => {
  test("open state sets aria-expanded=true and uses singular or plural sub-agent count", () => {
    const one = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} count={1} blocked={0} urgency="working" onToggle={noop} />,
    );
    expect(readAttr(one, "aria-expanded")).toBe("true");
    expect(readAttr(one, "aria-label")).toBe("Hide 1 sub-agent of deploy");

    const many = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} count={3} blocked={1} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(many, "aria-expanded")).toBe("true");
    expect(readAttr(many, "aria-label")).toBe("Hide 3 sub-agents of deploy");
  });

  test("folded state sets aria-expanded=false and reports blocked count with singular/plural grammar", () => {
    const plain = renderToStaticMarkup(
      <AgentFold name="tests" folded count={2} blocked={0} urgency="working" onToggle={noop} />,
    );
    expect(readAttr(plain, "aria-expanded")).toBe("false");
    expect(readAttr(plain, "aria-label")).toBe("Show 2 sub-agents of tests");
    expect(plain).not.toContain('aria-label="Needs you"');

    const oneBlocked = renderToStaticMarkup(
      <AgentFold name="deploy" folded count={1} blocked={1} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(oneBlocked, "aria-expanded")).toBe("false");
    expect(readAttr(oneBlocked, "aria-label")).toBe("Show 1 sub-agent of deploy, 1 needs you");
    expect(oneBlocked).toContain('role="img"');
    expect(oneBlocked).toContain('aria-label="Needs you"');

    const twoBlocked = renderToStaticMarkup(
      <AgentFold name="deploy" folded count={3} blocked={2} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(twoBlocked, "aria-expanded")).toBe("false");
    expect(readAttr(twoBlocked, "aria-label")).toBe("Show 3 sub-agents of deploy, 2 need you");
  });
});
