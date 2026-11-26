import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSection } from "./sidebar-section.tsx";

const headerClass = (markup: string): string => /<header class="([^"]*)"/u.exec(markup)?.[1] ?? "";

describe("SidebarSection", () => {
  test("aligns every header to pl-2 regardless of deprecated indent and marked props", () => {
    for (const indent of [false, true]) {
      for (const marked of [false, true]) {
        const markup = renderToStaticMarkup(
          <SidebarSection title="Needs you" count={2} indent={indent} marked={marked}>
            <div>row</div>
          </SidebarSection>,
        );
        const classes = headerClass(markup).split(" ");
        expect(classes).toContain("pl-2");
        expect(classes).toContain("text-xs");
        expect(classes).toContain("font-medium");
        expect(classes).toContain("justify-between");
        for (const legacy of ["pl-8.5", "pl-12.5", "pl-14", "pl-18"]) {
          expect(classes).not.toContain(legacy);
        }
      }
    }
  });

  test("places count 6px after title in one group and keeps action at the end", () => {
    const markup = renderToStaticMarkup(
      <SidebarSection
        title="Needs you"
        count={3}
        tone="text-status-blocked-text"
        action={<button type="button">Sort</button>}
      >
        <div>row</div>
      </SidebarSection>,
    );
    expect(markup).toContain('class="flex min-w-0 items-center gap-1.5"');
    expect(markup).toContain("text-status-blocked-text");
    expect(markup).toContain(">Needs you</h2>");
    expect(markup).toContain(">3</span></div><button");
    const h2Class = /<h2 [^>]*class="([^"]*)"/u.exec(markup)?.[1] ?? "";
    expect(h2Class.split(" ")).not.toContain("flex-1");
  });
});
