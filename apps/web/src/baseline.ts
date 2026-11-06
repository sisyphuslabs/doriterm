// The oldest browsers doriface runs in (#556). main.tsx calls checkBaseline() before it starts anything, so a browser
// below the baseline is told why and stops there, instead of starting the app and failing later as an unexplained
// "Cannot reach your host". The app's modules only define things when imported, so none of these is called before then.

/** Each newer feature the app's own code calls; Promise.withResolvers is the newest of them, so it sets BASELINE. */
const REQUIRED: readonly { readonly name: string; readonly present: () => boolean }[] = [
  { name: "Promise.withResolvers", present: () => typeof Promise.withResolvers === "function" },
  { name: "Array.prototype.toSorted", present: () => typeof Array.prototype.toSorted === "function" },
  { name: "Array.prototype.findLast", present: () => typeof Array.prototype.findLast === "function" },
  { name: "String.prototype.isWellFormed", present: () => typeof String.prototype.isWellFormed === "function" },
];

export const BASELINE = "Chrome or Edge 119, Safari 17.4, or Firefox 121";

function showUpdateScreen(missing: readonly string[]): void {
  const main = document.createElement("main");
  main.style.cssText =
    "box-sizing:border-box;min-height:100dvh;display:grid;place-content:center;gap:0.75rem;padding:1.5rem;max-width:32rem;margin:0 auto;font:16px/1.5 system-ui,sans-serif;color:CanvasText;background:Canvas";
  const heading = document.createElement("h1");
  heading.textContent = "Update your browser";
  heading.style.cssText = "margin:0;font-size:1.5rem";
  const need = document.createElement("p");
  need.style.margin = "0";
  need.textContent = `Doriterm needs ${BASELINE} or newer. Update this browser, or open Doriterm in one of those.`;
  const which = document.createElement("p");
  which.style.cssText = "margin:0;opacity:0.75;font-size:0.875rem";
  which.textContent = `This browser is missing: ${missing.join(", ")}.`;
  main.append(heading, need, which);
  document.body.replaceChildren(main);
}

/** Shows the update screen and throws, stopping the app's start, when this browser lacks a feature the app calls. */
export function checkBaseline(): void {
  const missing = REQUIRED.filter((feature) => !feature.present()).map((feature) => feature.name);
  if (missing.length === 0) return;
  showUpdateScreen(missing);
  throw new Error(`doriface: this browser is below the baseline (${BASELINE}); missing ${missing.join(", ")}`);
}
