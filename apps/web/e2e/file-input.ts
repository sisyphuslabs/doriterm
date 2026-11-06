import type { Page } from "@playwright/test";

/**
 * Clicks `button`, whose handler clicks a detached `<input type="file">`, and hands that input a text file.
 *
 * Waiting on Playwright's "filechooser" event races the protocol call that turns chooser interception on, so a click
 * that wins it opens a picker no one reports (#965). The page's own input gets the file instead, once: the override is
 * restored on first use, and every other input type keeps the real click.
 */
export async function pickFile(page: Page, button: string, name: string, text: string): Promise<void> {
  await page.evaluate(
    (file) => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type !== "file") return click.call(this);
        HTMLInputElement.prototype.click = click;
        const files = new DataTransfer();
        files.items.add(new File([file.text], file.name, { type: "text/plain" }));
        this.files = files.files;
        this.dispatchEvent(new Event("change"));
      };
    },
    { name, text },
  );
  await page.getByRole("button", { name: button }).click();
}
