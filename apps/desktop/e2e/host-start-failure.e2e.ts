import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOptions } from "./launch.ts";

type Theme = "day" | "night";

async function useThisComputer(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(
    (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
    theme,
  );
  await page.reload();
  await page.getByRole("button", { name: "Use this computer" }).click();
}

test("with herdr-core missing, This computer says so plainly, offers Retry, and never shows the host's usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-host-start-"));
  const missing = join(dir, "no-such-hc");
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HC_BIN: missing,
      DORIFACE_HOST_STATE_DIR: join(dir, "host-state"),
      XDG_STATE_HOME: join(dir, "state"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const app = await electron.launch(await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { env }));
  try {
    const page = await app.firstWindow();
    await page.waitForSelector("#root > *");
    const failsPlainly = async (theme: Theme): Promise<void> => {
      rmSync(missing, { force: true });
      await useThisComputer(page, theme);
      const notice = page.getByRole("alert").filter({ hasText: "This computer's host did not start" });
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice.locator("[data-host-start-code]")).toHaveAttribute(
        "data-host-start-code",
        "hc-binary-missing",
      );
      await expect(notice).toContainText(`herdr-core was not found at ${missing}.`);
      await expect(notice.getByRole("link", { name: "Get herdr-core" })).toBeVisible();
      const details = notice.locator("details");
      await expect(details.locator("pre")).toBeHidden();
      await expect(page.locator("body")).not.toContainText("usage:");
      await page.screenshot({ path: test.info().outputPath(`host-start-failed-${theme}.png`) });

      await details.locator("summary").click();
      await expect(details.locator("pre")).toContainText('"code":"hc-binary-missing"');
      await expect(details.locator("pre")).not.toContainText("usage:");
      await page.screenshot({ path: test.info().outputPath(`host-start-failed-details-${theme}.png`) });

      // Something now sits at that path but may not be run: Retry has to start the host again to say so.
      writeFileSync(missing, "#!/bin/sh\n", { mode: 0o644 });
      await notice.getByRole("button", { name: "Retry" }).click();
      await expect(notice.locator("[data-host-start-code]")).toHaveAttribute(
        "data-host-start-code",
        "permission-denied",
        { timeout: 20_000 },
      );
      await expect(notice).toContainText(`Doriterm may not run ${missing}.`);
    };
    await failsPlainly("day");
    await failsPlainly("night");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
