// measure() reads a control's ink only once every fade that paints it has finished: its own, and its ancestors', such as
// a menu popup's enter transition, which Base UI starts a frame after the popup mounts (#1362).
import { expect, test } from "./fixtures.ts";
import { measure } from "./painted-contrast.ts";

test("a reading taken while the item's popup fades in waits for the fade to finish", async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; background: #242321; }
      #popup { background: #242321; color: #e0e0e0; transition: opacity 2000ms linear; }
      #popup[data-starting-style] { opacity: 0; }
    </style>
    <div id="popup" data-starting-style><div role="menuitem">Terminal</div></div>
  `);
  // As Base UI does: the popup mounts in its starting style and drops it on the next frame, which starts the transition.
  await page.evaluate(() => {
    requestAnimationFrame(() => document.querySelector("#popup")?.removeAttribute("data-starting-style"));
  });
  const reading = await measure(page, page.getByRole("menuitem"));
  expect(reading.label).toBe("#e0e0e0 on #242321");
});

test("a fade that has finished but holds its last frame does not keep the reading waiting", async ({ page }) => {
  test.setTimeout(15_000);
  await page.setContent(`
    <style>body { margin: 0; background: #242321; } #popup { background: #242321; color: #e0e0e0; }</style>
    <div id="popup"><div role="menuitem">Terminal</div></div>
  `);
  // A `forwards` fill keeps a finished animation in document.getAnimations(), still in effect, with `finished` resolved.
  await page.evaluate(async () => {
    const fade = document
      .querySelector("#popup")
      ?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 50, fill: "forwards" });
    await fade?.finished;
  });
  const reading = await measure(page, page.getByRole("menuitem"));
  expect(reading.label).toBe("#e0e0e0 on #242321");
});
