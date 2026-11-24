import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpClientRow, type McpClientRowProps } from "./mcp-client-row.tsx";

const row = (props: Partial<McpClientRowProps> = {}): string =>
  renderToStaticMarkup(
    <McpClientRow name="Grok bot" connected="Connected 3 minutes ago" onDisconnect={() => {}} {...props} />,
  );

test("the Disconnect button's accessible name carries the client's name", () => {
  const markup = row({ name: "Grok bot" });
  expect(markup).toContain('aria-label="Disconnect Grok bot"');
  expect(markup).toContain(">Disconnect<");
  expect(markup).toContain('type="button"');
});

test("connected text is shown and details live behind a native details disclosure", () => {
  const withoutDetails = row();
  expect(withoutDetails).toContain("Connected 3 minutes ago");
  expect(withoutDetails).not.toContain("<details");

  const withDetails = row({ details: <span>3FA94C0E</span> });
  expect(withDetails).toContain("<details");
  expect(withDetails).toContain("Details</summary>");
  expect(withDetails).toContain("3FA94C0E");
});
