import { devices } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// 320 is the narrowest phone width the app supports, and the touch sizes apply there.
test.use({ ...phone, viewport: { width: 320, height: 640 }, serviceWorkers: "block" });

endOwnTerminals();

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** hc refuses to type into a blocked terminal unless forced. */
function report(address: string, state: string): void {
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

test("on a 320 px phone the session sheet fits: no row is cut and the sheet never scrolls sideways (#1467)", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const space = `psw-${run}`;
  const here = `psw-here-${run}`;
  const started = [startShellIn(space, here), startShellIn(space, `psw-asks-${run}`)];
  seedSpaces([
    {
      id: "spc-psw",
      name: space,
      folder: "",
      tabs: started.map((terminal, index) => ({ id: `tb-psw-${index}`, name: "", terminal })),
    },
  ]);
  report(started[1] ?? "", "blocked");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, here, false).click();
  await page
    .getByRole("banner")
    .getByRole("button", { name: `Session actions for ${here}`, exact: true })
    .click({ timeout: 15_000 });
  const sheet = page.getByRole("dialog", { name: here });
  await opened(sheet);
  await expect(sheet.getByRole("button", { name: /^Open the next agent that needs you/ })).toBeVisible();

  const sheetBox = await sheet.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(sheetBox.scroll).toBeLessThanOrEqual(sheetBox.client);
  // A label is cut when its text runs past the button's own right edge (or the sheet's).
  const cut = await sheet.getByRole("button").evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return text.width > 0 && (text.right > box.right + 0.5 || box.right > window.innerWidth + 0.5)
        ? [button.textContent]
        : [];
    }),
  );
  expect(cut).toEqual([]);
  report(started[1] ?? "", "working");
});
