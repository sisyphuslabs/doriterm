import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchCode } from "./match-code.tsx";

test("a match code is announced digit by digit, never as one number", () => {
  const markup = renderToStaticMarkup(<MatchCode code="482 913" label="Match code" />);
  expect(markup).toContain('aria-label="Match code: 4 8 2 9 1 3"');
});

test("a code given without its space is still shown in two groups of three", () => {
  expect(renderToStaticMarkup(<MatchCode code="482913" label="Match code" />)).toContain(">482 913<");
});
