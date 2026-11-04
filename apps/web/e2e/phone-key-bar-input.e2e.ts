import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block", ...PHONE });

function hc(...args: string[]): string {
  const { hc: bin, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8" });
}

test("ctrl latches for one key: ctrl then c interrupts a running command", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("sleep 30; echo slept-$((1+1))\r");
  const ctrl = key(page, "Control");
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("c");
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  // The shell prints after-42 only once it runs the line, which it does only when sleep was interrupted.
  await page.keyboard.type("echo after-$((40+2))");
  await key(page, "Arrow keys").click();
  await key(page, "Return").click();
  await expect(terminal).toContainText("after-42", { timeout: 10_000 });
  await expect(terminal).not.toContainText("slept-2");
});

test("the pad and the modifiers send the bytes a hardware keyboard would", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  // cat -v prints every byte it reads, control bytes as ^X, once a line ends.
  await page.keyboard.type("cat -v\r");
  await key(page, "Arrow keys").click();
  await key(page, "Up arrow").click();
  await key(page, "Control").click();
  await key(page, "Left arrow").click();
  await key(page, "Shift").click();
  await key(page, "Tab").click();
  await key(page, "Control").click();
  await key(page, "Shift").click();
  await key(page, "Right arrow").click();
  await key(page, "Clear screen").click();
  await key(page, "Escape").click();
  await page.keyboard.type("ab");
  await key(page, "Delete").click();
  await key(page, "Return").click();
  await expect(terminal).toContainText("^[[A^[[1;5D^[[Z^[[1;6C^L^[a", { timeout: 10_000 });
  await expect(key(page, "Control")).toHaveAttribute("aria-pressed", "false");
  await expect(key(page, "Shift")).toHaveAttribute("aria-pressed", "false");
});

test("swiped-in characters type into the terminal", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("echo 'x");
  await page.locator('[data-slot="terminal-keys-scroll"]').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await key(page, "Tilde").click();
  await key(page, "Vertical bar").click();
  await key(page, "Slash").click();
  await key(page, "Hyphen").click();
  await page.keyboard.type("y'\r");
  await expect(terminal).toContainText(/x~\|\/-y[\s\S]*x~\|\/-y/, { timeout: 10_000 });
});

test("Paste and the ctrl+v chord paste the device clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const terminal = await openPhoneTerminal(page);
  const clipboard = (text: string) => page.evaluate((value) => navigator.clipboard.writeText(value), text);

  await clipboard("echo pasted-$((6*7))");
  await key(page, "Paste").click();
  await expect(terminal).toContainText("echo pasted-$((6*7))", { timeout: 10_000 });
  await page.keyboard.type("\r");
  await expect(terminal).toContainText("pasted-42", { timeout: 10_000 });

  // The core here is not a mac, so ctrl+v is the paste chord.
  await clipboard("echo chord-$((5+5))");
  await key(page, "Control").click();
  await page.keyboard.type("v");
  await expect(terminal).toContainText("echo chord-$((5+5))", { timeout: 10_000 });
  await page.keyboard.type("\r");
  await expect(terminal).toContainText("chord-10", { timeout: 10_000 });
});

test("Switch session lists the terminals and opens the one picked", async ({ page }) => {
  const first = await openPhoneTerminal(page);
  const firstAddress = await first.getAttribute("data-terminal");
  if (firstAddress === null) throw new Error("the first terminal has no address");
  hc("label", firstAddress, `herdr.name=keys-one-${firstAddress}`);
  await page.getByRole("button", { name: "Back to agents" }).click();
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const second = page.locator("[data-terminal]");
  await expect(second).not.toHaveAttribute("data-terminal", firstAddress, { timeout: 15_000 });
  await expect(second).toContainText("$", { timeout: 15_000 });

  await key(page, "Switch session").click();
  await page.getByRole("menuitem", { name: new RegExp(`keys-one-${firstAddress}`) }).click();
  await expect(page.locator("header h1")).toHaveText(`keys-one-${firstAddress}`, { timeout: 15_000 });
  await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", firstAddress);
  await expect(keysBar(page)).toBeVisible();
});
