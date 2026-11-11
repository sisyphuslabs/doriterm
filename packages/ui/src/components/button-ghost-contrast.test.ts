import { describe, expect, test } from "bun:test";
import { BUILTIN_PALETTES } from "../theme/builtins.ts";
import { contrast, parseRgba } from "../theme/color.ts";
import { DISABLED_STEP, themeVariables } from "../theme/css.ts";
import { AA_GRAPHIC, flatten } from "../theme/guard.ts";
import { resolveTheme } from "../theme/resolve.ts";
import { buttonVariants } from "./button.tsx";

// #1897: the ghost Button's disabled icon is a fade of a theme role, read here from the classes the Button really
// emits, so this measures what ships: it holds 3:1 on every surface a ghost button sits on, and stays the Button spec's
// DISABLED_STEP from the enabled icon beside it (#1241), in every built-in theme.

/** The role and opacity a ghost Button class paints with, as `text-<role>` or `text-<role>/<percent>`. */
function paintOf(classes: readonly string[], prefix: string): { readonly role: string; readonly alpha: number } {
  const match = classes
    .map((name) => (name.startsWith(prefix) ? /^text-([a-z-]+)(?:\/(\d+))?$/.exec(name.slice(prefix.length)) : null))
    .find((found) => found !== null);
  if (match?.[1] === undefined) throw new Error(`no ${prefix}text-<role> class`);
  return { role: match[1], alpha: match[2] === undefined ? 1 : Number(match[2]) / 100 };
}

const ghost = buttonVariants({ variant: "ghost" }).split(/\s+/);
const enabledIcon = paintOf(ghost, "");
const disabledIcon = paintOf(ghost, "data-disabled:not-aria-busy:[&_svg]:");
const alphaHex = (alpha: number): string =>
  Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");

describe.each(Object.entries(BUILTIN_PALETTES))("%s: a disabled ghost Button's icon", (_, palette) => {
  const theme = resolveTheme(palette);
  const vars = themeVariables(theme);
  const role = (name: string): string => {
    const value = vars[name];
    if (value === undefined) throw new Error(`missing --${name}`);
    return value;
  };
  const base = parseRgba(theme.roles.background)?.rgb ?? 0;

  test.each(["canvas", "surface", "chrome", "popover", "raised"])(
    `on --%s holds ${AA_GRAPHIC}:1 and stays ${DISABLED_STEP} from the enabled icon`,
    (surface) => {
      const under = flatten(role(surface), base);
      const disabled = flatten(`${role(disabledIcon.role)}${alphaHex(disabledIcon.alpha)}`, under);
      const enabled = flatten(`${role(enabledIcon.role)}${alphaHex(enabledIcon.alpha)}`, under);
      expect(contrast(disabled, under)).toBeGreaterThanOrEqual(AA_GRAPHIC);
      expect(contrast(disabled, enabled)).toBeGreaterThanOrEqual(DISABLED_STEP);
    },
  );
});
