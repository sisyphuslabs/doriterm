export interface LayoutTiming {
  readonly duration: number;
  readonly easing: string;
}

const TOUCH_LAYOUT: LayoutTiming = {
  duration: 240,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};

/** DESIGN.md section 6: splits and pane moves animate on touch (240 ms `--ease-standard`) and snap on desktop (herdr-app). */
export function layoutMotion(matches: (query: string) => boolean): LayoutTiming | null {
  return matches("(pointer: coarse)") ? TOUCH_LAYOUT : null;
}
