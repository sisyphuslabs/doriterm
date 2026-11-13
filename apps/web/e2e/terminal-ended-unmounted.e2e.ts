import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { getCoreDoc } from "./core-doc.ts";
import { removeTerminal, stateOn, waitFor } from "./ended-terminal.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import {
  hcOn,
  machineRow,
  newOn,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The terminal is in the shared layout before the page or the machine carrying its write goes away. */
const savedPane = (terminal: string, on?: string) =>
  expect
    .poll(() => getCoreDoc(LAYOUT_DOC, on))
    .toMatchObject({
      spaces: [{ tabs: [{ root: { children: [{ content: { terminal } }] } }] }],
    });

/**
 * The program is started through hc, not typed: a wait-for line names this test's output path, and typed key by key on a
 * loaded runner it alone took most of a 60 s budget before the test reached what it checks (#1739). Each wait below has
 * its own bound; if every one ran to its limit they would add up to about 155 s, so 120 s is not their sum. It is a test
 * budget with room for a slow runner in a passing run, while a hang still fails here rather than at the default. The
 * reload's steps (ENDED_BOUNDS) add up to 100 s on their own, so the budget is 180 s.
 */
const ENDED_TEST_TIMEOUT_MS = 180_000;

/** A WebSocket frame's payload as text (an hc frame's JSON reads as latin1). */
const frameText = (payload: string | Buffer): string =>
  typeof payload === "string" ? payload : payload.toString("latin1");

/** The page's hc frames as text, in order, watched as they pass: routing them through the test is too slow on a loaded runner (#2396). */
function watchHcFrames(page: Page): { readonly sent: string[]; readonly received: string[] } {
  const frames = { sent: [] as string[], received: [] as string[] };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => frames.sent.push(frameText(payload)));
    socket.on("framereceived", ({ payload }) => frames.received.push(frameText(payload)));
  });
  return frames;
}

/** The RPC ids of the page's `method` requests for this terminal, in the order it sent them. */
function requestIds(sent: readonly string[], method: string, address: string): number[] {
  const request = new RegExp(
    `"id":(\\d+),"method":"${method.replace(".", "\\.")}","params":\\{"terminal":"${address}"`,
    "g",
  );
  return sent.flatMap((text) => [...text.matchAll(request)].map((match) => Number(match[1])));
}

/** Whether hc has answered the request with this RPC id: a JSON-RPC response (a result or an error) carrying that id. */
function answered(received: readonly string[], id: number): boolean {
  const ofId = new RegExp(`"id":${id}[,}]`);
  return received.some((text) => text.includes('"jsonrpc":"2.0"') && /"(result|error)":/.test(text) && ofId.test(text));
}

/**
 * After the reload the view must mount and fit before it attaches, which a starved renderer can spend most of a wait
 * on; hc refuses the attach (the program is over), and the view asks hc what is left (terminal.get) before it says the
 * session ended. Each step waits on its own bound and fails by name; one 20 s wait from the reload counted the time
 * before the attach was even sent. The answers need no more than the page's own call deadline (20 s).
 */
const ENDED_BOUNDS = { tab: 20_000, attach: 30_000, answer: 20_000, show: 15_000 } as const;

async function endedAfterReload(
  page: Page,
  frames: ReturnType<typeof watchHcFrames>,
  address: string,
  tabsBefore: number,
): Promise<void> {
  await expect(
    page.getByRole("tablist", { name: "Tabs" }).getByRole("tab"),
    "the layout shows the tab after the reload",
  ).toHaveCount(tabsBefore, { timeout: ENDED_BOUNDS.tab });
  const step = async (method: string, sentBound: number): Promise<void> => {
    await expect
      .poll(() => requestIds(frames.sent, method, address).length, {
        message: `the page sends ${method} after the reload`,
        timeout: sentBound,
      })
      .toBeGreaterThan(0);
    const id = requestIds(frames.sent, method, address)[0] ?? -1;
    await expect
      .poll(() => answered(frames.received, id), {
        message: `hc answers ${method} #${id}`,
        timeout: ENDED_BOUNDS.answer,
      })
      .toBe(true);
  };
  await step("terminal.attach", ENDED_BOUNDS.attach);
  await step("terminal.get", ENDED_BOUNDS.attach);
  await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: ENDED_BOUNDS.show });
}

test("a terminal whose program ends while the page is closed shows as ended after a reload, and closes from there", async ({
  page,
}) => {
  test.setTimeout(ENDED_TEST_TIMEOUT_MS);
  const go = test.info().outputPath("go");
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  try {
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    const tabsBefore = await tabs.count();
    hcOn("host", ["send", address, waitFor(go)]);
    await expect(terminal).toContainText("armed-9", { timeout: 15_000 });
    await savedPane(address);

    // The page goes away; its tabs stay saved, and the program ends meanwhile.
    await page.goto("about:blank");
    writeFileSync(go, "");
    await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).toBe("finished");
    const frames = watchHcFrames(page);
    await page.goto("/");

    try {
      await endedAfterReload(page, frames, address, tabsBefore);
    } catch (error) {
      // Which side lost the pane (#2412): the core's layout as it is now, and what the page sent and heard since the
      // reload. Written as files, so they land in test-results, which CI uploads; a body attachment the line reporter
      // shows only cut short.
      const doc = test.info().outputPath("core-herdr-app.json");
      writeFileSync(doc, JSON.stringify(await getCoreDoc(LAYOUT_DOC), null, 2));
      await test.info().attach("core herdr-app after the reload", { path: doc, contentType: "application/json" });
      const log = test.info().outputPath("page-hc-frames.txt");
      writeFileSync(
        log,
        [...frames.sent.map((text) => `> ${text}`), ...frames.received.map((text) => `< ${text}`)].join("\n"),
      );
      await test.info().attach("page hc frames since the reload", { path: log, contentType: "text/plain" });
      throw error;
    }
    await expect(page.getByText("This terminal didn't open")).toHaveCount(0);
    await expect(tabs).toHaveCount(tabsBefore);
    await page.getByRole("button", { name: "Close tab" }).click();
    await expect(tabs).toHaveCount(tabsBefore - 1, { timeout: 15_000 });
    await expect(page.getByText("This session ended")).toHaveCount(0);
  } finally {
    removeTerminal("host", address, go);
  }
});

test("a terminal on an added machine whose program ends while the machine is offline shows as ended once it is back", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const go = test.info().outputPath("go");
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await newOn(page).click({ force: true });
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`), {
    timeout: 15_000,
  });
  const address = (await focused.getAttribute("data-terminal")) ?? "";
  // The machine's own core names it without the machine prefix.
  const local = address.slice(MACHINE_NAME.length + 1);
  try {
    const terminal = page.locator(`[data-terminal="${address}"]`);
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    const tabsBefore = await tabs.count();
    hcOn("machine", ["send", local, waitFor(go)]);
    await expect(terminal).toContainText("armed-9", { timeout: 15_000 });
    await savedPane(local, MACHINE_NAME);

    // The line to the machine drops; its core and the program keep running, and the status line says the machine is offline.
    switchTo("drop");
    // #2003 (DORITERM-11): the view stays mounted and the status line says the machine is offline.
    await expect(
      page
        .getByRole("contentinfo")
        .getByRole("status")
        .filter({ hasText: `${MACHINE_NAME} is offline` }),
    ).toBeVisible({
      timeout: OFFLINE_BOUND_MS,
    });
    await expect(terminal).toHaveCount(1);
    writeFileSync(go, "");
    await expect.poll(() => stateOn("machine", local), { timeout: 15_000 }).toBe("finished");
    reconnect();
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });

    await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("This terminal didn't open")).toHaveCount(0);
    await expect(tabs).toHaveCount(tabsBefore);
    await page.getByRole("button", { name: "Close tab" }).click();
    // The close is a layout write to a machine that has just come back: it settles within the bound for its state.
    await expect(tabs).toHaveCount(tabsBefore - 1, { timeout: STATE_BOUND_MS });
  } finally {
    reconnect();
    removeTerminal("machine", local, go);
  }
});
