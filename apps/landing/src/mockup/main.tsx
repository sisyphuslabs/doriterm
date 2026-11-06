import { TooltipProvider } from "@doriface/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopView, PhoneView } from "./views.tsx";

/** The landing names its pinned theme "light" or "dark"; the app's presets for those are Day and Night. */
const THEMES: Readonly<Record<string, string>> = { light: "day", dark: "night" };

function applyTheme(choice: string | null): void {
  const theme = choice === null ? undefined : THEMES[choice];
  if (theme === undefined) delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
}

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme"));
// Only the landing page on this same origin may re-theme the mockup.
addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (typeof data === "object" && data !== null && "theme" in data) {
    const { theme } = data as { readonly theme: unknown };
    applyTheme(typeof theme === "string" ? theme : null);
  }
});
// A picture of the app, not the app: nothing in it takes focus or input.
document.body.inert = true;

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider delay={400}>{params.get("view") === "phone" ? <PhoneView /> : <DesktopView />}</TooltipProvider>
    </StrictMode>,
  );
}
