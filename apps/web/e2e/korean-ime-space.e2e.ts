import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

/**
 * A space next to a Korean composition, through Chromium's own input-method path (CDP `Input.imeSetComposition`,
 * `Input.insertText`, key events with keyCode 229), so the browser fires the real composition and input events in the
 * orders input methods use (#1508). Each order reaches the program as 가 가, once, on the desktop field and on a touch
 * device's field (which keeps a placeholder). These are Chromium's events, not a device's input method: iOS Safari and
 * Android keyboards are checked by hand.
 */
test.use({ serviceWorkers: "block" });

const READ_LINE = "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1 | tr -d ' \\n'; echo :end\r";
const GA = "\uAC00";
const G = "\u3131";
const A = "\u314F";

type Step =
  | readonly ["down229", string, string]
  | readonly ["up", string, string, number]
  | readonly ["compose", string]
  | readonly ["commit", string]
  | readonly ["spaceKey"];

/** 가 composed as ㄱ then 가, each jamo with its keydown (229) and keyup, and committed as `commit` when given. */
function syllable(commit: string | null): Step[] {
  const steps: Step[] = [
    ["down229", G, "KeyR"],
    ["compose", G],
    ["up", G, "KeyR", 82],
    ["down229", A, "KeyK"],
    ["compose", GA],
    ["up", A, "KeyK", 75],
  ];
  if (commit !== null) steps.push(["commit", commit]);
  return steps;
}

const ORDERS: readonly { readonly name: string; readonly steps: readonly Step[] }[] = [
  {
    // macOS 2-Set Korean on Chromium and Electron, as recorded: the space joins the composition and the commit carries it.
    name: "the space joins the composition and the commit carries it (macOS Chromium)",
    steps: [
      ...syllable(null),
      ["down229", " ", "Space"],
      ["commit", `${GA} `],
      ["up", " ", "Space", 32],
      ...syllable(GA),
    ],
  },
  {
    name: "the preedit grows to hold the space, then commits",
    steps: [
      ...syllable(null),
      ["down229", " ", "Space"],
      ["compose", `${GA} `],
      ["commit", `${GA} `],
      ["up", " ", "Space", 32],
      ...syllable(GA),
    ],
  },
  {
    // Android keyboards and the Windows input methods: the syllable is committed, then the space is inserted as text.
    name: "the syllable commits, then the input method inserts the space as text",
    steps: [...syllable(GA), ["commit", " "], ...syllable(GA)],
  },
  {
    name: "a space key reported as 229 while composing, the syllable committed alone, then the space inserted",
    steps: [
      ...syllable(null),
      ["down229", " ", "Space"],
      ["commit", GA],
      ["commit", " "],
      ["up", " ", "Space", 32],
      ...syllable(GA),
    ],
  },
  {
    name: "the syllable commits, then a plain space key",
    steps: [...syllable(GA), ["spaceKey"], ...syllable(GA)],
  },
];

async function keyEvent(
  cdp: CDPSession,
  type: "rawKeyDown" | "keyDown" | "keyUp",
  key: string,
  code: string,
  keyCode: number,
  text?: string,
): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
  });
}

async function run(cdp: CDPSession, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    // oxlint-disable-next-line no-await-in-loop -- each event changes what the browser does with the next
    await (async () => {
      switch (step[0]) {
        case "down229":
          return keyEvent(cdp, "rawKeyDown", step[1], step[2], 229);
        case "up":
          return keyEvent(cdp, "keyUp", step[1], step[2], step[3]);
        case "compose":
          return cdp.send("Input.imeSetComposition", {
            text: step[1],
            selectionStart: step[1].length,
            selectionEnd: step[1].length,
          });
        case "commit":
          return cdp.send("Input.insertText", { text: step[1] });
        case "spaceKey":
          await keyEvent(cdp, "keyDown", " ", "Space", 32, " ");
          return keyEvent(cdp, "keyUp", " ", "Space", 32);
      }
    })();
  }
}

async function expectLine(page: Page, terminal: Locator, hex: string): Promise<void> {
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(new RegExp(`(^|\\s)${hex.replaceAll(" ", "")}:end`), { timeout: 10_000 });
}

async function openDesktopReader(page: Page): Promise<Locator> {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(READ_LINE);
  return terminal;
}

test.describe("desktop field", () => {
  for (const order of ORDERS) {
    test(`${order.name}: 가 가 reaches the program once (#1508)`, async ({ page }) => {
      const terminal = await openDesktopReader(page);
      const cdp = await page.context().newCDPSession(page);
      await run(cdp, order.steps);
      // The echo is on screen before Enter: nothing drawn twice either.
      await expect(terminal.locator(".term-row").filter({ hasText: `${GA} ${GA}` })).toHaveCount(1);
      await expectLine(page, terminal, "ea b0 80 20 ea b0 80");
    });
  }

  test("plain text typed fast, spaces included, reaches the program as typed", async ({ page }) => {
    const terminal = await openDesktopReader(page);
    await page.keyboard.type("ab cd  ef", { delay: 0 });
    await expectLine(page, terminal, "61 62 20 63 64 20 20 65 66");
  });
});

test.describe("touch field", () => {
  test.use({ serviceWorkers: "block", ...PHONE });
  for (const order of ORDERS) {
    test(`${order.name}: 가 가 reaches the program once on a phone (#1508)`, async ({ page }) => {
      const terminal = await openPhoneTerminal(page);
      await page.keyboard.type(READ_LINE);
      const cdp = await page.context().newCDPSession(page);
      await run(cdp, order.steps);
      await expect(terminal.locator(".term-row").filter({ hasText: `${GA} ${GA}` })).toHaveCount(1);
      await expectLine(page, terminal, "ea b0 80 20 ea b0 80");
    });
  }
});
