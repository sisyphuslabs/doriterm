import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouPill } from "./needs-you-pill.tsx";

const noop = (): void => {};

const readAttr = (markup: string, attr: string): string | undefined =>
  new RegExp(`${attr}="([^"]*)"`).exec(markup)?.[1];

describe("NeedsYouPill", () => {
  test("returns null when count is 0 or negative", () => {
    expect(NeedsYouPill({ count: 0, onOpen: noop })).toBeNull();
    expect(NeedsYouPill({ count: -2, onOpen: noop })).toBeNull();
    expect(renderToStaticMarkup(<NeedsYouPill count={0} onOpen={noop} />)).toBe("");
  });

  test("renders label, aria-label, and title for counts 1 and 3", () => {
    const one = renderToStaticMarkup(<NeedsYouPill count={1} onOpen={noop} />);
    expect(readAttr(one, "aria-label")).toBe("1 needs you, open the next");
    expect(readAttr(one, "title")).toBe("Open the next terminal that needs you");
    expect(one).toContain("1 needs you</button>");

    const three = renderToStaticMarkup(<NeedsYouPill count={3} onOpen={noop} />);
    expect(readAttr(three, "aria-label")).toBe("3 needs you, open the next");
    expect(readAttr(three, "title")).toBe("Open the next terminal that needs you");
    expect(three).toContain("3 needs you</button>");
  });

  test("compact shows only the number while keeping the full aria-label", () => {
    const compact = renderToStaticMarkup(<NeedsYouPill count={3} compact onOpen={noop} />);
    expect(readAttr(compact, "aria-label")).toBe("3 needs you, open the next");
    expect(compact).toContain(">3</button>");
    expect(compact).not.toContain("3 needs you</button>");
  });

  test("clicking the pill calls onOpen", () => {
    let calls = 0;
    const element = NeedsYouPill({
      count: 2,
      onOpen: () => {
        calls += 1;
      },
    });
    expect(element).not.toBeNull();
    const props = element?.props as { readonly onClick?: () => void } | undefined;
    props?.onClick?.();
    expect(calls).toBe(1);
  });
});
