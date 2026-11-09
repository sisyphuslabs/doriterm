import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./icon-button.tsx";
import { PinSymbol } from "./pin-symbol.tsx";
import { TooltipProvider } from "./tooltip.tsx";

async function rendered(disabled: boolean) {
  const result = { slot: "", button: "", nativeDisabled: false, styledDisabled: false };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <IconButton label="Pin" icon={<PinSymbol pinned />} disabled={disabled} />
    </TooltipProvider>,
  );
  await new HTMLRewriter()
    .on("[data-pin-symbol]", {
      element: (element) => {
        result.slot = element.getAttribute("class") ?? "";
      },
    })
    .on("button", {
      element: (element) => {
        result.button = element.getAttribute("class") ?? "";
        result.nativeDisabled = element.hasAttribute("disabled");
        result.styledDisabled = element.hasAttribute("data-disabled");
      },
    })
    .transform(new Response(html))
    .text();
  return result;
}

test("the real disabled prop keeps the pin slot and exposes the disabled style the browser proof exercises", async () => {
  const enabled = await rendered(false);
  const disabled = await rendered(true);
  expect(enabled.slot.split(" ")).toContain("size-5");
  expect(disabled.slot).toBe(enabled.slot);
  expect(disabled.button).toBe(enabled.button);
  expect(disabled.button.split(" ")).toContain("active:scale-100");
  expect(enabled.nativeDisabled).toBe(false);
  expect(enabled.styledDisabled).toBe(false);
  expect(disabled.nativeDisabled).toBe(true);
  expect(disabled.styledDisabled).toBe(true);
});
