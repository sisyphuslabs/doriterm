import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceTab } from "./tab-bar.tsx";
import { TabOverflowMenu } from "./tab-overflow-menu.tsx";

const TABS: readonly WorkspaceTab[] = [
  { id: "t1", title: "claude-code", status: "blocked" },
  { id: "t2", title: "tests", status: "working" },
  { id: "t3", title: "shell", status: "idle" },
];

interface ItemProps {
  readonly "aria-current"?: string;
  readonly icon?: ReactElement;
  readonly onClick?: () => void;
  readonly children: ReactElement;
}

const textOf = (element: ReactElement | undefined): string =>
  renderToStaticMarkup(element ?? <></>).replace(/<[^>]*>/g, "");

const itemsOf = (activeId: string, onSelect: (id: string) => void): readonly ItemProps[] => {
  const menu = TabOverflowMenu({ tabs: TABS, activeId, onSelect });
  const { children } = menu.props as { readonly children: readonly ReactElement[] };
  return children.map((item) => item.props as ItemProps);
};

describe("TabOverflowMenu", () => {
  test("its trigger is named All tabs", () => {
    const markup = renderToStaticMarkup(<TabOverflowMenu tabs={TABS} activeId="t2" onSelect={() => {}} />);
    expect(markup).toContain('aria-label="All tabs"');
  });

  test("lists every tab in order, by title and status, and marks only the active one current", () => {
    const items = itemsOf("t2", () => {});
    expect(items.map((item) => textOf(item.children))).toEqual(["claude-code", "tests", "shell"]);
    expect(items.map((item) => item["aria-current"])).toEqual([undefined, "true", undefined]);
    expect(renderToStaticMarkup(items[0]?.icon ?? <></>)).toContain('aria-label="Needs you"');
    expect(renderToStaticMarkup(items[1]?.icon ?? <></>)).toContain('aria-label="Working"');
  });

  test("choosing an item selects that tab", () => {
    const selected: string[] = [];
    itemsOf("t2", (id) => selected.push(id))[2]?.onClick?.();
    expect(selected).toEqual(["t3"]);
  });
});
