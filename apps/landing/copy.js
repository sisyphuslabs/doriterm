/**
 * A code block's Copy button: copies `text()` and says so on its [data-copy-label] for 1.6 s. The words come from the
 * button (its label, then data-copied and data-copy-failed), so a page in another language brings its own.
 */
export function bindCopy(button, text) {
  const label = button.querySelector("[data-copy-label]");
  const idle = label.textContent;
  const { copied = "Copied", copyFailed = "Select and copy" } = button.dataset;
  let timer;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      label.textContent = copied;
    } catch {
      label.textContent = copyFailed;
    }
    clearTimeout(timer);
    timer = setTimeout(() => (label.textContent = idle), 1600);
  });
}
