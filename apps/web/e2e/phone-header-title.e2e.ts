// #479: on a phone the terminal screen's title is the one thing that names it; the status chip and the controls beside
// it must leave it a readable share of the header, with the whole title still available.
import { devices, type Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

const TITLES = {
  korean: "배포 파이프라인 정리하고 결과 보고하기",
  english: "remote-build-server deploy pipeline review",
} as const;

/** An agent that needs the person (the widest status chip), renamed to `title`. */
function startNamed(name: string, title: string): string {
  const report = `printf '\\033]7501;state=blocked\\033\\\\'; exec sleep 600`;
  const out = hcOn("host", [
    "run",
    "--bg",
    "--name",
    name,
    "--label",
    "space=titles",
    "--label",
    `herdr.name=${title}`,
    "--",
    "sh",
    "-c",
    report,
  ]);
  return String(Reflect.get(JSON.parse(out) as object, "address"));
}

/** How many characters of the title the heading shows, laid out wholly inside its box (an ellipsis is not one). */
const shownCharacters = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("heading", { level: 1 })
    .evaluate((heading) => {
      const box = heading.getBoundingClientRect();
      const text = heading.querySelector("[data-title-lines]")?.firstChild;
      if (text === null || text === undefined || text.nodeType !== Node.TEXT_NODE) return 0;
      const characters = [...new Intl.Segmenter().segment(text.textContent ?? "")];
      const range = document.createRange();
      let inside = 0;
      for (const { index, segment } of characters) {
        range.setStart(text, index);
        range.setEnd(text, index + segment.length);
        const rect = range.getBoundingClientRect();
        const within = rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5;
        const shown = segment.trim() !== "" && segment !== "\u2026";
        if (within && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5 && shown) inside += 1;
      }
      return inside;
    });

for (const [script, title] of Object.entries(TITLES)) {
  test(`a long ${script} title keeps at least 12 characters in the phone header, whole in its tooltip`, async ({
    page,
  }) => {
    const address = startNamed(`title-${script}`, title);
    try {
      await page.goto("/");
      await page.getByRole("region", { name: "Agents" }).getByRole("button").filter({ hasText: title }).click();
      const bar = page.getByRole("banner");
      const heading = bar.getByRole("heading", { level: 1, name: title });
      await expect(heading).toBeVisible({ timeout: 15_000 });
      await expect(heading).toHaveAttribute("title", title);
      await expect(bar.getByText("Needs you")).toBeAttached();

      expect(await shownCharacters(page)).toBeGreaterThanOrEqual(12);
      // Nothing of the title sits under the controls beside it.
      const headingRight = await heading.evaluate((el) => el.getBoundingClientRect().right);
      const firstControl = await bar
        .getByRole("button", { name: "Switch space or tab" })
        .evaluate((el) => el.getBoundingClientRect().left);
      expect(headingRight).toBeLessThanOrEqual(firstControl + 0.5);
    } finally {
      endAgent("host", address);
    }
  });
}
