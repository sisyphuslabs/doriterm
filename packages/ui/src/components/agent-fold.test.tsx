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
  test("open state sets aria-expanded=true and names the agent and sub-agent count", () => {
    const one = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} count={1} blocked={0} urgency="working" onToggle={noop} />,
    );
    expect(readAttr(one, "aria-expanded")).toBe("true");
    expect(readAttr(one, "aria-disabled")).toBeUndefined();
    expect(readAttr(one, "aria-label")).toContain("deploy");
    expect(readAttr(one, "aria-label")).toContain("1");
    expect(one).not.toContain('aria-label="Needs you"');

    const many = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} count={3} blocked={1} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(many, "aria-expanded")).toBe("true");
    expect(readAttr(many, "aria-label")).toContain("deploy");
    expect(readAttr(many, "aria-label")).toContain("3");
    expect(many).not.toContain('aria-label="Needs you"');
  });

  test("folded state sets aria-expanded=false, renders the count, and shows the Needs you badge when blocked", () => {
    const plain = renderToStaticMarkup(
      <AgentFold name="tests" folded count={2} blocked={0} urgency="working" onToggle={noop} />,
    );
    expect(readAttr(plain, "aria-expanded")).toBe("false");
    expect(readAttr(plain, "aria-label")).toContain("tests");
    expect(readAttr(plain, "aria-label")).toContain("2");
    expect(plain).toContain(">2<");
    expect(plain).not.toContain('aria-label="Needs you"');

    const oneBlocked = renderToStaticMarkup(
      <AgentFold name="deploy" folded count={1} blocked={1} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(oneBlocked, "aria-expanded")).toBe("false");
    expect(readAttr(oneBlocked, "aria-label")).toContain("deploy");
    expect(readAttr(oneBlocked, "aria-label")).toContain("1");
    expect(oneBlocked).toContain(">1<");
    expect(oneBlocked).toContain('role="img"');
    expect(oneBlocked).toContain('aria-label="Needs you"');

    const twoBlocked = renderToStaticMarkup(
      <AgentFold name="deploy" folded count={3} blocked={2} urgency="blocked" onToggle={noop} />,
    );
    expect(readAttr(twoBlocked, "aria-expanded")).toBe("false");
    expect(readAttr(twoBlocked, "aria-label")).toContain("deploy");
    expect(readAttr(twoBlocked, "aria-label")).toContain("3");
    expect(readAttr(twoBlocked, "aria-label")).toContain("2");
    expect(twoBlocked).toContain(">3<");
    expect(twoBlocked).toContain('role="img"');
    expect(twoBlocked).toContain('aria-label="Needs you"');
  });

  test("disabled state sets aria-disabled, uses muted tone, says so in a label of its own, and ignores clicks", () => {
    const markup = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} disabled count={2} blocked={0} urgency="working" onToggle={noop} />,
    );
    const enabled = renderToStaticMarkup(
      <AgentFold name="deploy" folded={false} count={2} blocked={0} urgency="working" onToggle={noop} />,
    );
    expect(readAttr(markup, "aria-expanded")).toBe("true");
    expect(readAttr(markup, "aria-disabled")).toBe("true");
    expect(readAttr(markup, "aria-label")).toContain("deploy");
    expect(readAttr(markup, "aria-label")).not.toBe(readAttr(enabled, "aria-label"));
    expect(readAttr(markup, "title")).toBe(readAttr(markup, "aria-label"));
    expect(readAttr(markup, "class")?.split(" ")).toContain("text-disabled-glyph");

    let toggles = 0;
    const onToggle = (): void => {
      toggles += 1;
    };
    const enabledProps = AgentFold({
      name: "deploy",
      folded: false,
      count: 2,
      blocked: 0,
      urgency: "working",
      onToggle,
    }).props as { readonly onClick?: () => void };
    enabledProps.onClick?.();
    expect(toggles).toBe(1);

    const disabledProps = AgentFold({
      name: "deploy",
      folded: false,
      disabled: true,
      count: 2,
      blocked: 0,
      urgency: "working",
      onToggle,
    }).props as { readonly onClick?: () => void };
    disabledProps.onClick?.();
    expect(toggles).toBe(1);
  });
});
