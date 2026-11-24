import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileTerminal } from "./mobile.tsx";

// The keys bar draws the arrow pad itself since #2778; the screen drawing its own as well showed two.
test("the phone terminal with the pad open shows one arrow pad", () => {
  const markup = renderToStaticMarkup(<MobileTerminal pad />);
  expect(markup.match(/role="group" aria-label="Arrow keys"/g)).toHaveLength(1);
});
