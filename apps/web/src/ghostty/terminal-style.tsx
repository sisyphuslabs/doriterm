import { useEffect, useMemo } from "react";
import { pinchedConfig, usePinchFontSize } from "../terminal/pinch-font-store.ts";
import { useTerminalConfig } from "./config-store.ts";
import { terminalCss } from "./render-css.ts";

/**
 * One stylesheet for every terminal on the page, rebuilt when the config changes. It is an adopted
 * CSSStyleSheet rather than a <style> element because the desktop CSP (style-src 'self') blocks inline styles.
 */
export function TerminalStyle() {
  const device = useTerminalConfig();
  // A size pinched on this device draws every terminal, over the configured one (redesign section 7).
  const pinched = usePinchFontSize();
  const css = useMemo(() => terminalCss(pinchedConfig(device, pinched)), [device, pinched]);
  const sheet = useMemo(() => new CSSStyleSheet(), []);
  useEffect(() => {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    };
  }, [sheet]);
  useEffect(() => sheet.replaceSync(css), [sheet, css]);
  return null;
}
