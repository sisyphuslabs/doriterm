import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListedSpace } from "./model.ts";
import { PhoneSpace } from "./phone-space.tsx";
import { SpaceCloseContext, type SpaceClosing } from "./space-close-context.ts";

/** A space whose last tab ended: its screen shows New tab here and Close space. */
const space: ListedSpace = {
  id: "space:local/spc-web",
  name: "website",
  tabs: 0,
  addresses: [],
  tabPanes: [],
  tabPins: [],
  tabNames: [],
  dir: "/work/website",
};

const GONE = "This space is no longer in the layout.";
const OFFLINE = "The layout cannot take changes now: the machine is not connected";

function screen(closing: Omit<SpaceClosing, "ask">): string {
  return renderToStaticMarkup(
    <SpaceCloseContext value={{ ask: () => undefined, ...closing }}>
      <PhoneSpace
        space={space}
        terminals={[]}
        host="studio"
        arrive={false}
        from="spaces"
        onOpen={() => undefined}
        onBack={() => undefined}
        onNew={() => undefined}
      />
    </SpaceCloseContext>,
  );
}

/** Whether the screen's button with exactly this text is disabled; undefined when it has none. */
function disabled(html: string, text: string): boolean | undefined {
  const found = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].find(
    ([, , inner = ""]) => inner.replace(/<[^>]+>/g, "") === text,
  );
  return found === undefined ? undefined : / disabled=""/.test(found[1] ?? "");
}

describe("a phone's space screen (#2455)", () => {
  test("a space gone from the layout refuses Close only: New tab is offered, with no machine wait (#2466 review)", () => {
    const html = screen({ refusal: () => GONE, editWait: () => null });
    expect(disabled(html, "New tab here")).toBe(false);
    expect(disabled(html, "Close space")).toBe(true);
    expect(html).not.toContain(GONE);
  });

  test("a space whose machine cannot take edits waits on both, saying why", () => {
    const html = screen({ refusal: () => OFFLINE, editWait: () => OFFLINE });
    expect(disabled(html, "New tab here")).toBe(true);
    expect(disabled(html, "Close space")).toBe(true);
    expect(html).toContain("the machine is not connected");
  });
});
