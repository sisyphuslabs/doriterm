import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { KOREAN_SPACE_RECORDINGS, type RecordedStep } from "./korean-ime-recorded.ts";

test.use({ serviceWorkers: "block" });

// The shell reads one line and prints its bytes in hex, so a space sent twice, a syllable sent twice or a loose jamo shows.
const READ_LINE = "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1 | tr -d ' \\n'; echo :end\r";

async function openReader(page: Page): Promise<Locator> {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(READ_LINE);
  return terminal;
}

/** Fires the recorded events at the terminal's field in order, making each edit where the browser made it. */
async function replay(field: Locator, steps: readonly RecordedStep[]): Promise<void> {
  await field.evaluate((element, recorded) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
    const box = element;
    let compositionStart = 0;
    let compositionLength = 0;
    for (const step of recorded) {
      if (step.kind === "keydown" || step.kind === "keyup") {
        const { key, code, keyCode, composing } = step;
        box.dispatchEvent(
          new KeyboardEvent(step.kind, { bubbles: true, cancelable: true, key, code, keyCode, isComposing: composing }),
        );
      } else if (step.kind === "compositionstart") {
        compositionStart = box.selectionStart;
        compositionLength = 0;
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      } else if (step.kind === "compositionupdate" || step.kind === "compositionend") {
        box.dispatchEvent(new CompositionEvent(step.kind, { bubbles: true, data: step.data }));
      } else {
        const { inputType, data, composing } = step;
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data, isComposing: composing }));
        if (inputType === "insertCompositionText") {
          box.setRangeText(data, compositionStart, compositionStart + compositionLength, "end");
          compositionLength = data.length;
        } else {
          const end = Math.min(step.to, box.value.length);
          box.setRangeText(data, Math.min(step.from, end), end, "end");
        }
        box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data, isComposing: composing }));
      }
    }
  }, steps);
}

for (const recording of KOREAN_SPACE_RECORDINGS) {
  test(`${recording.platform}: ${recording.name} reaches the program as typed (#1508)`, async ({ page }) => {
    const terminal = await openReader(page);
    await replay(terminal.getByRole("textbox"), recording.steps);
    const hex = recording.bytes.replaceAll(" ", "").replace(/0d$/, "");
    await expect(terminal).toContainText(new RegExp(`(^|\\s)${hex}:end`), { timeout: 10_000 });
  });
}
