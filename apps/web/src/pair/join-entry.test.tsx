import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRun } from "./first-run.tsx";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";

test("a stranger with empty storage is offered Join a mesh and Paste invite", () => {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <FirstRun />
    </RouterContextProvider>,
  );
  expect(html).toContain("Join a mesh");
  expect(html).toContain("Paste invite");
  expect(html).not.toContain("Pair it again");
});
