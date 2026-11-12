import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneOfflineNote } from "./machine-status.tsx";
import { MachinesContext } from "./use-machines.ts";

test("a split pane's header names a login its machine needs, not 'offline' (#2375 review)", () => {
  const value = { views: [{ id: "m1", name: "box", state: "needs_login" }] } as never;
  const html = renderToStaticMarkup(
    <MachinesContext.Provider value={value}>
      <PaneOfflineNote machine="box" />
    </MachinesContext.Provider>,
  );
  expect(html).toContain("box needs a login");
  expect(html).not.toContain("is offline");
});
