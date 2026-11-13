import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

test("the workspace keeps style-src strict and still hides Base UI's native scrollbars (#499)", async () => {
  // A cold Electron launch on a loaded Linux runner can take most of the default minute on its own.
  test.setTimeout(180_000);
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const app = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  try {
    const page = await app.firstWindow();
    console.log("stage window");
    // Chromium reports every refused inline style on the console; listening from the reload on sees the whole session.
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) violations.push(message.text().slice(0, 160));
    });
    await page.reload();
    await page.getByRole("button", { name: "Use this computer" }).click({ timeout: 60_000 });
    console.log("stage host");
    await pressNewTab(page, { timeout: 60_000 });
    await expect(page.locator('[data-focused="true"] [data-terminal]')).toContainText("$", { timeout: 60_000 });

    const viewports = page.locator(".base-ui-disable-scrollbar");
    expect(await viewports.count()).toBeGreaterThan(0);
    const widths = await viewports.evaluateAll((elements) => elements.map((el) => getComputedStyle(el).scrollbarWidth));
    // A short viewport overflows, so a native scrollbar would show if the rule did not apply.
    await viewports.first().evaluate((el) => {
      (el as HTMLElement).style.maxHeight = "24px";
    });
    await page.screenshot({
      path: test.info().outputPath("sidebar.png"),
      clip: { x: 0, y: 0, width: 280, height: 220 },
    });
    console.log(`scrollbar-width ${JSON.stringify(widths)} violations ${JSON.stringify(violations)}`);
    expect(violations).toEqual([]);
    expect(widths.every((width) => width === "none")).toBe(true);
  } finally {
    await app.close();
    await hc.dispose();
    rmSync(profile, { recursive: true, force: true });
    rmSync(shellHome, { recursive: true, force: true });
  }
});
