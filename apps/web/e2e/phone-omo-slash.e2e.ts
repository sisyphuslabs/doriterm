// The phone's Type field lists OmO's slash commands as `/` is typed into it, read from OmO itself (#2658). A fake `omo`
// in this spec's own directory answers `--mode rpc` with a command list and otherwise echoes the lines it is sent.
import type { Page } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const COMMANDS = [
  { name: "goal", description: "Set the goal this session works toward", syntax: "slash" },
  { name: "todo", description: "Show or edit the todo list", syntax: "slash" },
  { name: "handoff", description: "Hand the session over to a fresh one", syntax: "slash" },
  { name: "help", description: "List what OmO can do", syntax: "slash" },
  { name: "skill:writing", description: "A skill, named with $", syntax: "dollar" },
];

const FAKE_OMO = `#!/bin/sh
if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  read -r request
  printf '%s\\n' '{"type":"model_changed"}'
  printf '%s\\n' '${JSON.stringify({ id: "r", type: "response", command: "get_commands", success: true, data: { commands: COMMANDS } })}'
  exit 0
fi
printf 'OmO ready\\n'
while IFS= read -r line; do printf 'omo ran %s\\n' "$line"; done
`;

let dir = "";
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-slash-"));
  writeFileSync(join(dir, "omo"), FAKE_OMO);
  chmodSync(join(dir, "omo"), 0o755);
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const field = (page: Page) => page.getByLabel("Type into the terminal");
const commands = (page: Page) => page.getByRole("listbox", { name: "OmO commands" });

async function startOmo(page: Page) {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  await page.keyboard.type(`cd '${dir}' && PATH="$PWD:$PATH" && clear && omo`);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("OmO ready", { timeout: 15_000 });
  await expect(field(page)).toHaveAttribute("role", "combobox");
  return terminal;
}

test("a / at the empty field lists OmO's commands, more letters narrow them, and a tap runs one", async ({ page }) => {
  const terminal = await startOmo(page);
  await page.keyboard.type("/");
  await expect(commands(page).getByRole("option")).toHaveText([/^\/goal/, /^\/todo/, /^\/handoff/, /^\/help/]);
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.type("h");
  await expect(commands(page).getByRole("option")).toHaveText([/^\/handoff/, /^\/help/]);
  const help = commands(page).getByRole("option", { name: /^\/help/ });
  const box = await help.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  await help.click();
  await expect(terminal).toContainText("omo ran /help", { timeout: 15_000 });
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toBeFocused();
  await expect(commands(page)).toBeHidden();
});

test("arrows and Enter pick from the keyboard, Escape and Backspace put the list away", async ({ page }) => {
  const terminal = await startOmo(page);
  await page.keyboard.type("/");
  await expect(commands(page).getByRole("option")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(commands(page)).toBeHidden();
  await expect(field(page)).toHaveValue("/");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/t");
  await expect(commands(page).getByRole("option")).toHaveText([/^\/todo/]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(commands(page)).toBeHidden();

  await page.keyboard.type("/");
  await page.keyboard.press("ArrowDown");
  await expect(commands(page).getByRole("option", { selected: true })).toHaveText(/^\/todo/);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("omo ran /todo", { timeout: 15_000 });

  // A command with words after it is a line like any other: the space puts the list away and Send sends it whole.
  await page.keyboard.type("/goal ship it");
  await expect(commands(page)).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("omo ran /goal ship it", { timeout: 15_000 });
});

test("a shell is not OmO: a / in the field lists nothing", async ({ page }) => {
  await openPhoneTerminal(page);
  await field(page).click();
  await page.keyboard.type("/");
  await expect(field(page)).toHaveValue("/");
  await expect(field(page)).not.toHaveAttribute("role", "combobox");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});
