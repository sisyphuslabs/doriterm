import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSection } from "./sidebar-section.tsx";

describe("SidebarSection", () => {
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
