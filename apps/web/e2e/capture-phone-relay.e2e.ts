// A real terminal session over the production relay, at 390, one capture per behaviour (#664-#667).
// CAPTURE=1 RELAY_PAIR_LINK='#h=…&k=…&s=…&p=…&r=wss%3A%2F%2F…' bunx playwright test capture-phone-relay
import { devices } from "@playwright/test";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";
import { pointOnRowStart } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const link = process.env["RELAY_PAIR_LINK"] ?? "";

test.skip(process.env["CAPTURE"] !== "1" || link === "", "needs CAPTURE=1 and a pairing link from the relay host");

test("a phone session through the production relay", async ({ browser }) => {
  test.setTimeout(180_000);
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  const context = await browser.newContext({ ...phone, colorScheme: "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await fakeSoftKeyboard(page);
  try {
    await page.goto(`/pair${link}`);
    await page.getByRole("button", { name: "They match" }).click({ timeout: 60_000 });
    await page.getByRole("link", { name: "Open terminals" }).click({ timeout: 90_000 });
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "New tab" }).click({ timeout: 30_000 });
    const terminal = page.locator("[data-terminal]");
    await expect(terminal).toContainText("$", { timeout: 90_000 });
    // The prompt comes from the capture host's own rcfile, so nothing is typed here and no echo can satisfy the check
    // (#926). What is asserted is the state the shots depend on: the last line of the buffer IS the neutral prompt.
    const lastLine = async (): Promise<string> => {
      const lines = (await terminal.innerText()).trimEnd().split("\n");
      let last = "";
      for (const line of lines) if (line.trim() !== "") last = line;
      return last.trim();
    };
    await expect.poll(lastLine, { timeout: 90_000 }).toBe("demo@my-laptop:~/project$");
    await page.keyboard.type("printf 'relay-%s\\n' 'alpha-line more'\r");
    await expect(terminal).toContainText("relay-alpha-line more", { timeout: 30_000 });
    const shot = async (name: string): Promise<void> => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(OUT, `mobile-keys-relay-${name}-390-day.png`), animations: "disabled" });
    };
    await shot("bar");

    await page.getByLabel("Type into the terminal").click();
    await expect(page.getByLabel("Type into the terminal")).toBeFocused();
    await page.keyboard.type("echo 안녕하세요");
    await shot("input");
    await key(page, "Send").click();
    await expect(terminal).toContainText("안녕하세요", { timeout: 30_000 });

    const at = await pointOnRowStart(terminal, "relay-alpha-line more");
    const touch = await Touch.on(page);
    await touch.down(at);
    await expect(page.locator(".term-selection-cells > div").first()).toBeAttached();
    await touch.up(at);
    await expect(page.getByRole("menu", { name: "Selected text" })).toBeVisible();
    await shot("select");
    await page.getByRole("menu", { name: "Selected text" }).getByRole("menuitem", { name: "Copy" }).click();

    await page.evaluate(() => navigator.clipboard.writeText("한글붙여넣기"));
    await key(page, "Paste").click();
    await expect(terminal).toContainText("한글붙여넣기", { timeout: 30_000 });
    await shot("paste");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("command not found", { timeout: 30_000 });
    await page.keyboard.type("printf '<%s>\\n' ");
    await key(page, "Paste").click();
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("<한글붙여넣기>", { timeout: 30_000 });
    await shot("paste-split");
  } finally {
    await context.close();
  }
});
