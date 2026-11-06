// Applies a theme pinned with the page's switch before first paint, so the page never flashes the other palette.
// Blocked site storage throws on access; the page then simply follows the system theme.
(() => {
  document.documentElement.classList.remove("no-js");
  try {
    const pinned = localStorage.getItem("doriterm-theme");
    if (pinned === "light" || pinned === "dark") document.documentElement.dataset.theme = pinned;
  } catch {}
})();
