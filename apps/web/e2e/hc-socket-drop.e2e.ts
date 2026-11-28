// The harness's relay blip (hc-socket.ts drop) is a lost network for the host too: the dropped connection's viewers leave
// the core, as they do when a real socket closes (#2390).
import { endAgent, startShell } from "./agents.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { endOwnTerminals } from "./own-terminals.ts";

endOwnTerminals();

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("a dropped link takes the page's viewer off the core: its terminal runs at the size of one nobody views", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await expect.poll(async () => coreSize(address) === (await gridSize(terminal)), { timeout: 15_000 }).toBe(true);
  const unviewed = startShell("host", "drop-unviewed");
  try {
    await link.drop(true);
    await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(coreSize(unviewed));
  } finally {
    endAgent("host", unviewed);
    link.restore();
  }
});
