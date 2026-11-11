import { cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["2xs", "prose"] }] } },
});

/** Joins class names and lets later Tailwind utilities win over earlier ones. */
export function cn(...inputs: Parameters<typeof cx>): string {
  return merge(cx(...inputs));
}
