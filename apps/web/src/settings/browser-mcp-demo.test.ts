import { expect, test } from "bun:test";
import { browserMcpDemoEnabled } from "./browser-mcp-demo.tsx";

test("a demo query enables only a preview build on a preview hostname", () => {
  const search = "?mcp-demo=1";
  for (const hostname of ["app.doriterm.com", "doriface.omo.dev"]) {
    expect(browserMcpDemoEnabled({ hostname, search }, "1")).toBe(false);
  }
  const preview = { hostname: "demo-pr.workers.dev", search };
  expect(browserMcpDemoEnabled(preview, "0")).toBe(false);
  expect(browserMcpDemoEnabled(preview, "1")).toBe(true);
});
