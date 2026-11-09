import { Pin } from "lucide-react";
import { cn } from "../lib/cn.ts";

const symbols = {
  outline: [
    new URL("../styles/symbols/pin@1x.png", import.meta.url).href,
    new URL("../styles/symbols/pin@2x.png", import.meta.url).href,
    new URL("../styles/symbols/pin@3x.png", import.meta.url).href,
  ],
  filled: [
    new URL("../styles/symbols/pin.fill@1x.png", import.meta.url).href,
    new URL("../styles/symbols/pin.fill@2x.png", import.meta.url).href,
    new URL("../styles/symbols/pin.fill@3x.png", import.meta.url).href,
  ],
} as const;

/** A fixed symbol slot: native Apple pin/pin.fill at their rendered size, or the same stock SVG on other platforms. */
export function PinSymbol({
  pinned,
  label,
  className,
}: {
  readonly pinned: boolean;
  readonly label?: string;
  readonly className?: string;
}) {
  const apple = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const [one, two, three] = symbols[pinned ? "filled" : "outline"];
  return (
    <span
      data-pin-symbol
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className={cn("flex size-5 shrink-0 items-center justify-center", apple && "bg-current", className)}
      style={
        apple
          ? {
              maskImage: `image-set(url("${one}") 1x, url("${two}") 2x, url("${three}") 3x)`,
              maskSize: "20px 20px",
              maskRepeat: "no-repeat",
            }
          : undefined
      }
    >
      {apple ? null : <Pin aria-hidden className="size-4" fill={pinned ? "currentColor" : "none"} />}
    </span>
  );
}
