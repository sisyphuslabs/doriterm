import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouPill } from "./needs-you-pill.tsx";

const noop = (): void => {};

const ariaLabel = (markup: string): string | undefined => /aria-label="([^"]*)"/.exec(markup)?.[1];
const shownText = (markup: string): string => markup.replace(/<[^>]*>/g, "");

describe("NeedsYouPill", () => {
  test("renders nothing when no other terminal needs you", () => {
    expect(NeedsYouPill({ count: 0, onOpen: noop })).toBeNull();
    expect(NeedsYouPill({ count: -2, onOpen: noop })).toBeNull();
    expect(renderToStaticMarkup(<NeedsYouPill count={0} onOpen={noop} />)).toBe("");
  });

  test("shows the count with its words and is named for what a tap does", () => {
    const one = renderToStaticMarkup(<NeedsYouPill count={1} onOpen={noop} />);
    expect(ariaLabel(one)).toBe("1 needs you, open the next");
    expect(shownText(one)).toContain("1 needs you");

    const three = renderToStaticMarkup(<NeedsYouPill count={3} onOpen={noop} />);
    expect(ariaLabel(three)).toBe("3 needs you, open the next");
    expect(shownText(three)).toContain("3 needs you");
  });

  test("compact shows only the number and keeps the full name", () => {
    const compact = renderToStaticMarkup(<NeedsYouPill count={3} compact onOpen={noop} />);
    expect(ariaLabel(compact)).toBe("3 needs you, open the next");
    expect(shownText(compact)).toContain("3");
    expect(shownText(compact)).not.toContain("needs you");
  });

  test("a click opens the next terminal that needs you", () => {
    let calls = 0;
    const element = NeedsYouPill({
      count: 2,
      onOpen: () => {
        calls += 1;
      },
    });
    const props = element?.props as { readonly onClick?: () => void } | undefined;
    props?.onClick?.();
    expect(calls).toBe(1);
  });
});
