import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtraKeysBar } from "./extra-keys-bar.tsx";
import { DEFAULT_EXTRA_KEYS } from "./extra-keys-defaults.tsx";

/** The bar's own chrome, which is not a key of the person's row. */
const CHROME = new Set(["Terminal keys", "Arrow keys", "Switch session", "Paste", "Type in a field", "Hide keyboard"]);

/** The names of the bar's keys, in the order they are drawn. */
const drawnKeys = (markup: string): readonly string[] =>
  [...markup.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1] ?? "").filter((name) => !CHROME.has(name));

describe("the keys bar without a keys prop", () => {
  // The landing page's mockup draws the bar with latched keys and nothing else; when the person's keys became a prop,
  // that call rendered an empty bar (#770). A caller with no keys of its own keeps the built-in row.
  test("still draws the built-in row rather than an empty one", () => {
    const markup = renderToStaticMarkup(<ExtraKeysBar latched={["ctrl"]} />);
    expect(drawnKeys(markup)).toEqual(DEFAULT_EXTRA_KEYS.map((entry) => entry.name));
    expect(markup).toContain('aria-label="Control C"');
    expect(markup).toContain('aria-label="Arrow left"');
  });

  test("draws the keys it is given instead, in that order", () => {
    const keys = [
      { id: "ctrl", label: "ctrl", name: "Control", modifier: true },
      { id: "esc", label: "esc", name: "Escape" },
    ];
    const markup = renderToStaticMarkup(<ExtraKeysBar keys={keys} />);
    expect(drawnKeys(markup)).toEqual(["Control", "Escape"]);
    expect(markup).not.toContain('aria-label="Arrow left"');
  });
});
