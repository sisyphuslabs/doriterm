import { TooltipProvider } from "@doriface/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyFrameMessage, applyTheme, holdMotion } from "./frame-message.ts";
import { DesktopView, PhoneView } from "./views.tsx";

const params = new URLSearchParams(location.search);
applyTheme(document.documentElement, params.get("theme"));
// Only the landing page on this same origin may re-theme the mockup or pause its motion.
addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== location.origin) return;
  applyFrameMessage(document.documentElement, event.data);
  if (typeof event.data === "object" && event.data !== null && "motionPaused" in event.data) {
    holdMotion(document, document.documentElement.dataset["motion"] === "paused");
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
