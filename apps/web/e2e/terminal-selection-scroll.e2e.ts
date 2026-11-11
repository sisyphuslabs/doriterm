import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block" });

async function history(page: Page): Promise<Locator> {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("terminal has no address");
  // Interactive programs enable focus reports (DECSET 1004). Selecting text blurs and refocuses the input even when
  // the program is silent; those protocol reports must not be treated as typing that resumes following output.
  hcOn("host", [
    "send",
    address,
    "stty -echo; printf '\\033[?1004h'; for i in $(seq 1 300); do printf 'history-%03d-copy\\n' $i; done; " +
      "while IFS= read -r request; do case \"$request\" in *request-output*) printf 'new-output-%s\\n' arrived;; esac; done",
  ]);
  await expect(terminal).toContainText("history-300-copy", { timeout: 15_000 });
  await terminal.evaluate((element) => {
    const row = element.querySelector(".term-row");
    if (row === null) throw new Error("terminal has no row");
    element.scrollTop -= row.getBoundingClientRect().height * 50;
  });
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  return terminal;
}

const position = (terminal: Locator) => terminal.evaluate((element) => element.scrollTop);

/** Select the exact glyphs under the pointer, without a locator action scrolling them into view first. */
async function selectHistory(page: Page, terminal: Locator): Promise<string> {
  const box = await terminal.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll(".term-row")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top > bounds.top + 40 && rect.bottom < bounds.bottom - 40;
    });
    if (row === undefined) throw new Error("no history row in view");
    const text = row.textContent?.trim() ?? "";
    const range = document.createRange();
    range.selectNodeContents(row);
    const rect = range.getBoundingClientRect();
    return { text, left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  expect(box.text).toMatch(/^history-\d{3}-copy$/);
  const before = await position(terminal);
  const sampling = terminal.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const positions: number[] = [];
        const sample = (): void => {
          positions.push(element.scrollTop);
          if (element.hasAttribute("data-stop-scroll-sample")) {
            element.removeAttribute("data-stop-scroll-sample");
            resolve(positions);
          } else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  let positions: number[] = [];
  try {
    await page.mouse.move(box.left + 1, box.y);
    await page.mouse.down();
    expect.soft(await position(terminal), "mousedown preserves the history position").toBe(before);
    await page.mouse.move(box.right - 1, box.y, { steps: 8 });
    expect.soft(await position(terminal), "drag preserves the history position").toBe(before);
    await page.mouse.up();
  } finally {
    await terminal.evaluate((element) => element.setAttribute("data-stop-scroll-sample", ""));
    // Awaited on every exit, so a failed check above is the only error the run reports (#2125).
    positions = await sampling;
  }
  expect(positions.length).toBeGreaterThan(1);
  expect
    .soft(
      positions.filter((top) => top !== before),
      "no frame moves the selection away from its original row",
    )
    .toEqual([]);
  return box.text;
}

test("selecting history keeps the viewport and copies the text under the pointer (#1368)", async ({ page }, info) => {
  const socket = await routeHcSocket(page);
  const terminal = await history(page);
  const before = await position(terminal);
  const sent = socket.sent().length;
  const selected = await selectHistory(page, terminal);
  await expect.poll(() => position(terminal)).toBe(before);
  // Keeping the view must not suppress the focus reports the program requested.
  await expect.poll(() => socket.sent().slice(sent).join("")).toContain("\x1b[O");
  await expect.poll(() => socket.sent().slice(sent).join("")).toContain("\x1b[I");
  const copied = await terminal.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData("text/plain");
  });
  expect(copied.trim()).toBe(selected);
  await expect(terminal.locator(".term-selection-cells > div").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("selected-history.png") });
});

test("output after selecting history keeps the viewport and offers jump to latest (#1368)", async ({ page }) => {
  const terminal = await history(page);
  const before = await position(terminal);
  await selectHistory(page, terminal);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("terminal has no address");
  hcOn("host", ["send", address, "request-output"]);
  await expect(terminal).toContainText("new-output-arrived");
  await expect.poll(() => position(terminal)).toBe(before);
  const jump = page.getByRole("button", { name: "Jump to bottom" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect
    .poll(() => terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThan(2);
  await expect(jump).toBeHidden();
});

test("resizing after selecting history keeps the same top row (#1368)", async ({ page }) => {
  const terminal = await history(page);
  const firstRow = () =>
    terminal.evaluate((element) => {
      const top = element.getBoundingClientRect().top + element.clientTop;
      // Trimmed: a row's text is padded to the terminal's width, which the resize changes.
      return [...element.querySelectorAll(".term-row")]
        .find((row) => row.getBoundingClientRect().bottom > top + 1)
        ?.textContent?.trim();
    });
  const anchor = await firstRow();
  await selectHistory(page, terminal);
  await page.setViewportSize({ width: 1000, height: 600 });
  await expect.poll(firstRow).toBe(anchor);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
});

test("switching tabs and returning keeps the history position with focus reports enabled (#1368)", async ({ page }) => {
  const terminal = await history(page);
  const before = await position(terminal);
  await openNewTerminal(page);
  await page.getByRole("tablist", { name: "Tabs" }).getByRole("tab").first().click();
  await expect(terminal).toBeVisible();
  await expect.poll(() => position(terminal)).toBe(before);
});

test("new output alone leaves a reader in history until they jump to the end", async ({ page }) => {
  const terminal = await history(page);
  const before = await position(terminal);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("terminal has no address");
  hcOn("host", ["send", address, "request-output"]);
  await expect(terminal).toContainText("new-output-arrived");
  await expect.poll(() => position(terminal)).toBe(before);
  await expect(page.getByRole("button", { name: "Jump to bottom, new output below" })).toBeVisible();
});
