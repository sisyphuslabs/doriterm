import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyBlock, type CopyBlockProps } from "./copy-block.tsx";

const block = (props: Partial<CopyBlockProps> = {}): string =>
  renderToStaticMarkup(
    <CopyBlock text="doriface-host connect <link or code>" label="Connect command" onCopy={() => {}} {...props} />,
  );

test("the copy button's accessible name carries the action and label", () => {
  expect(block()).toContain('aria-label="Copy: Connect command"');
  expect(block({ label: "MCP settings config", copyLabel: "Copy config" })).toContain(
    'aria-label="Copy config: MCP settings config"',
  );
});

test("visible label switches to Copied while keeping the idle label in the layout sizer", () => {
  const idle = block({ copied: false, copyLabel: "Copy config" });
  expect(idle).toContain('<span class="col-start-1 row-start-1">Copy config</span>');
  expect(idle).toContain('<span class="col-start-1 row-start-1 invisible" aria-hidden="true">Copied</span>');

  const done = block({ copied: true, copyLabel: "Copy config" });
  expect(done).toContain('<span class="col-start-1 row-start-1 invisible" aria-hidden="true">Copy config</span>');
  expect(done).toContain('<span class="col-start-1 row-start-1">Copied</span>');
});
