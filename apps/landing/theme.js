// The nav's theme switch (System / Light / Dark), shared by the landing (main.js) and the docs pages (docs.js).
// public/theme-init.js applies a pinned choice before first paint; this keeps the buttons and the stored choice in step.
const STORAGE_KEY = "doriterm-theme";

/** Wires the [data-theme-choice] buttons; `onApply` hears every choice, the one the page starts with included. */
export function setupTheme(onApply = () => {}) {
  const buttons = [...document.querySelectorAll("[data-theme-choice]")];
  const apply = (choice) => {
    onApply(choice);
    if (choice === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    // Blocked site storage throws: the choice then lasts for this page only.
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {}
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  };
  apply(document.documentElement.dataset.theme ?? "system");
  for (const button of buttons) button.addEventListener("click", () => apply(button.dataset.themeChoice));
}
