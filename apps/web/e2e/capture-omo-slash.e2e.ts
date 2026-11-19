// Before/after captures of the phone's Type field with `/` typed while OmO runs, at 390 (#2658).
// CAPTURE=1 SHOT=<name> bunx playwright test capture-omo-slash
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
test.use({ serviceWorkers: "block", ...PHONE });

const OUT = join(import.meta.dirname, "../../../.github/assets/pr-2658");
const LIST = JSON.stringify({
  id: "r",
  type: "response",
  command: "get_commands",
  success: true,
  data: {
    commands: [
      { name: "goal", description: "Set the goal this session works toward" },
      { name: "todo", description: "Show or edit the todo list" },
      { name: "handoff", description: "Hand the session over to a fresh one" },
      { name: "help", description: "List what OmO can do" },
    ],
  },
});

test("slash at the empty field", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "omo-shot-"));
  try {
    writeFileSync(
      join(dir, "omo"),
      `#!/bin/sh\nif [ "$1" = "--mode" ]; then read -r r; printf '%s\\n' '${LIST}'; exit 0; fi\nprintf 'OmO ready\\n'\nwhile IFS= read -r l; do :; done\n`,
    );
    chmodSync(join(dir, "omo"), 0o755);
    const terminal = await openPhoneTerminal(page);
    const field = page.getByLabel("Type into the terminal");
    await field.click();
    await page.keyboard.type(`cd '${dir}' && PATH="$PWD:$PATH" && clear && omo`);
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("OmO ready", { timeout: 15_000 });
    await page.keyboard.type("/");
    await expect(field).toHaveValue("/");
    // Before the change the field lists nothing; after it, the shot waits for OmO's answer.
    if (process.env["SHOT"] !== "before") await expect(page.getByRole("option")).toHaveCount(4, { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT, `${process.env["SHOT"] ?? "after"}-390.png`), animations: "disabled" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
