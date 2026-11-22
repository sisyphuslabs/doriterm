import { expect, openNewTerminal, test } from "./fixtures.ts";
import { expectImageBelow, graphics, images, png, RED, show } from "./terminal-images.ts";

test.use({ serviceWorkers: "block" });

test("an agent's virtual Kitty image follows its placeholder cells, not the transmit cursor", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const transmit = graphics("a=t,f=100,q=2,i=23", png(RED).toString("base64"));
  const place = "\x1b_Ga=p,U=1,q=2,i=23,p=7,c=2,r=1\x1b\\";
  await show(page, terminal, "stored", transmit + place);
  await expect(images(terminal)).toHaveCount(0);

  const cell = "\u{10eeee}\u0305";
  const row = `\x1b[38;2;0;0;23m\x1b[58:2::0:0:7m${cell}\u0305${cell}\u030d\x1b[0m`;
  await show(page, terminal, "placed", row);
  await expectImageBelow(terminal, "placed", RED);
  await expect(terminal).not.toContainText("\u{10eeee}");
  await show(page, terminal, "erased", "\x1b[2J");
  await expect(images(terminal)).toHaveCount(0);
});
