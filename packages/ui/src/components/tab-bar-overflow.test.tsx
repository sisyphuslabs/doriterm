import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar, TabOverflowMenu, type WorkspaceTab } from "./tab-bar.tsx";

const TABS: readonly WorkspaceTab[] = [
  { id: "t1", title: "claude-code", status: "blocked" },
  { id: "t2", title: "tests", status: "working" },
  { id: "t3", title: "shell", status: "idle" },
];

describe("TabBar layout and overflow menu", () => {
  test("does not grow the tab scroller and keeps the drag spacer after New tab", () => {
    const markup = renderToStaticMarkup(<TabBar tabs={TABS} activeId="t1" />);
    expect(markup).toContain("flex-initial");
    expect(markup).toContain('<div aria-hidden="true" class="flex-1 self-stretch"></div>');
    expect(markup).not.toContain('aria-label="All tabs"');
    expect(markup).not.toContain("data-overflow-start=");
    expect(markup).not.toContain("data-overflow-end=");
  });

  test("TabOverflowMenu renders an All tabs trigger, lists every tab with active aria-current, and selects on click", () => {
    const triggerMarkup = renderToStaticMarkup(<TabOverflowMenu tabs={TABS} activeId="t2" onSelect={() => {}} />);
    expect(triggerMarkup).toContain('aria-label="All tabs"');

    const selected: string[] = [];
    const menu = TabOverflowMenu({
      tabs: TABS,
      activeId: "t2",
      onSelect: (id) => {
        selected.push(id);
      },
    });
    const menuProps = menu.props as { readonly children: readonly ReactElement[] };
    expect(menuProps.children).toHaveLength(3);

    const itemProps = menuProps.children.map(
      (item) =>
        item.props as {
          readonly "aria-current"?: string;
          readonly icon?: ReactElement;
          readonly onClick?: () => void;
          readonly children: ReactElement;
        },
    );
    expect(itemProps[0]?.["aria-current"]).toBeUndefined();
    expect(itemProps[1]?.["aria-current"]).toBe("true");
    expect(itemProps[2]?.["aria-current"]).toBeUndefined();

    // Active item carries the check mark and every item carries its status glyph and title.
    expect(renderToStaticMarkup(itemProps[0]?.children ?? <></>)).toContain("claude-code");
    expect(renderToStaticMarkup(itemProps[0]?.children ?? <></>)).not.toContain("<svg");
    expect(renderToStaticMarkup(itemProps[1]?.children ?? <></>)).toContain("tests");
    expect(renderToStaticMarkup(itemProps[1]?.children ?? <></>)).toContain("<svg");
    expect(renderToStaticMarkup(itemProps[0]?.icon ?? <></>)).toContain('aria-label="Needs you"');
    expect(renderToStaticMarkup(itemProps[1]?.icon ?? <></>)).toContain('aria-label="Working"');

    itemProps[2]?.onClick?.();
    expect(selected).toEqual(["t3"]);
  });
});
