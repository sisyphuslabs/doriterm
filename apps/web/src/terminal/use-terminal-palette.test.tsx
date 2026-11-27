import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TerminalStream } from "@doriface/client";
import type { Display } from "@doriface/protocol";
import type { TerminalThemeColors, WTerm } from "@wterm/react";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Appearance, AppearanceSource } from "../appearance/appearance.ts";
import { DEFAULT_APPEARANCE } from "../appearance/stored.ts";
import { EMPTY_CONFIG, type TerminalConfig } from "../ghostty/config.ts";
import { type PaletteRefreshDeps, useTerminalPalette } from "./use-terminal-palette.ts";

const view = { HTMLIFrameElement: function NoFrame() {}, document: { activeElement: null } };
const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  namespaceURI: "http://www.w3.org/1999/xhtml",
  addEventListener() {},
  removeEventListener() {},
  ownerDocument: { addEventListener() {}, removeEventListener() {}, defaultView: view },
} as unknown as Element;

function fakeAppearance(initial: Appearance): AppearanceSource & { set(patch: Partial<Appearance>): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get value() {
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      value = { ...value, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

function fakeFrames() {
  const pending = new Set<() => void>();
  const schedule = (run: () => void): (() => void) => {
    pending.add(run);
    return () => pending.delete(run);
  };
  const flush = (): void => {
    const batch = [...pending];
    pending.clear();
    for (const run of batch) run();
  };
  return { schedule, flush, count: () => pending.size };
}

function makeColors(bg: number, fg = 0xd8d4cb, red = 0xe08a7e): TerminalThemeColors {
  return {
    foreground: fg,
    background: bg,
    cursor: fg,
    palette: [
      0x4a4640,
      red,
      0xa9c08f,
      0xdcbb7f,
      0x9fb4e6,
      0xc4a6d6,
      0x8fc2bb,
      0xd8d4cb,
      0x8a857d,
      0xf0a59a,
      0xbfd6a6,
      0xecd29f,
      0xbccbf2,
      0xd7bde6,
      0xa9d6cf,
      0xf4f1ea,
    ],
  };
}

function customThemeFile(background: string, red: string) {
  return {
    background,
    foreground: "#e8e6df",
    selection: "#334455",
    cursor: "#ffffff",
    ansi: [
      "#111111",
      red,
      "#22aa44",
      "#ccaa22",
      "#3366cc",
      "#aa44cc",
      "#22aaaa",
      "#cccccc",
      "#555555",
      "#ff5566",
      "#44cc66",
      "#eecc44",
      "#5588ee",
      "#cc66ee",
      "#44cccc",
      "#ffffff",
    ],
  };
}

interface ProbeProps {
  readonly wt: WTerm | null;
  readonly config: TerminalConfig;
  readonly dark: boolean;
  readonly stream: RefObject<TerminalStream | null>;
  readonly deps: PaletteRefreshDeps;
  readonly onRender: () => void;
}

function Probe(props: ProbeProps) {
  props.onRender();
  useTerminalPalette(props.wt, props.config, props.dark, props.stream, props.deps);
  return null;
}

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
});

describe("useTerminalPalette (#2966)", () => {
  test("refreshes palette and stream facts in place on same-kind and custom theme changes without calling fit", async () => {
    const events: string[] = [];
    let currentColors = makeColors(0x161513);
    let currentFacts: Display = { fg: "#d8d4cb", bg: "#161513", cursor: "#d8d4cb" };
    let cleared = false;

    const wt = {
      element: {} as HTMLElement,
      setThemeColors(colors: TerminalThemeColors | null) {
        if (colors === null) {
          cleared = true;
          events.push("clear");
        } else {
          cleared = false;
          events.push(`set:${colors.background.toString(16)}:${colors.palette[1]?.toString(16)}`);
        }
      },
      fit() {
        events.push("fit");
      },
    } as unknown as WTerm;

    const stream: RefObject<TerminalStream | null> = {
      current: {
        facts(display: Display) {
          events.push(`facts:${display.bg ?? "null"}`);
        },
      } as unknown as TerminalStream,
    };

    const appearance = fakeAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", dark: "night", light: "day" });
    const frames = fakeFrames();
    const deps: PaletteRefreshDeps = {
      appearance,
      schedule: frames.schedule,
      readColors: () => {
        events.push(`read:cleared=${String(cleared)}`);
        return currentColors;
      },
      readFacts: () => currentFacts,
    };

    let renders = 0;
    const render = (config: TerminalConfig = EMPTY_CONFIG, dark = true) =>
      act(async () =>
        root.render(
          <Probe wt={wt} config={config} dark={dark} stream={stream} deps={deps} onRender={() => (renders += 1)} />,
        ),
      );

    await render();
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:161513:e08a7e", "facts:#161513"]);
    events.length = 0;

    // Unrelated appearance updates (density, inactive light theme) do not re-render or schedule work.
    const rendersBefore = renders;
    await act(async () => appearance.set({ density: "compact" }));
    await act(async () => appearance.set({ light: "paper" }));
    expect(renders).toBe(rendersBefore);
    expect(frames.count()).toBe(0);

    // Same-kind dark theme switch (Night -> Dracula): clears inline styles, re-reads, sets, updates facts, no fit.
    currentColors = makeColors(0x282a36, 0xf8f8f2, 0xff5555);
    currentFacts = { fg: "#f8f8f2", bg: "#282a36", cursor: "#f8f8f2" };
    await act(async () => appearance.set({ dark: "dracula" }));
    expect(frames.count()).toBe(1);
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:282a36:ff5555", "facts:#282a36"]);
    events.length = 0;

    // Custom theme imported, then re-imported under the same id with different colours.
    const customV1 = { id: "custom:live", name: "live", file: customThemeFile("#101820", "#ff3344") };
    currentColors = makeColors(0x101820, 0xe8e6df, 0xff3344);
    currentFacts = { fg: "#e8e6df", bg: "#101820", cursor: "#ffffff" };
    await act(async () => appearance.set({ custom: [customV1], dark: customV1.id, mode: "dark" }));
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:101820:ff3344", "facts:#101820"]);
    events.length = 0;

    const customV2 = { id: "custom:live", name: "live", file: customThemeFile("#1a1025", "#ee7722") };
    currentColors = makeColors(0x1a1025, 0xe8e6df, 0xee7722);
    currentFacts = { fg: "#e8e6df", bg: "#1a1025", cursor: "#ffffff" };
    await act(async () => appearance.set({ custom: [customV2] }));
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:1a1025:ee7722", "facts:#1a1025"]);
    events.length = 0;

    // Terminal config override preserved when Appearance changes: readColors reads the config override after clear.
    currentColors = makeColors(0x112233, 0xd8d4cb, 0xff00ff);
    currentFacts = { fg: "#d8d4cb", bg: "#112233", cursor: "#d8d4cb" };
    await act(async () => appearance.set({ dark: "nord" }));
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:112233:ff00ff", "facts:#112233"]);
    events.length = 0;

    // System dark scheme flip still refreshes (e.g. for system mode or terminal config theme=light:...,dark:...).
    currentColors = makeColors(0xfbfaf7, 0x2a2723, 0xb8322a);
    currentFacts = { fg: "#2a2723", bg: "#fbfaf7", cursor: "#2a2723" };
    await render(EMPTY_CONFIG, false);
    frames.flush();
    expect(events).toEqual(["clear", "read:cleared=true", "set:fbfaf7:b8322a", "facts:#fbfaf7"]);
    expect(events).not.toContain("fit");
  });

  test("cancels a pending frame when a second palette change arrives before paint", async () => {
    const applied: number[] = [];
    let currentBg = 0x161513;
    const wt = {
      element: {} as HTMLElement,
      setThemeColors(colors: TerminalThemeColors | null) {
        if (colors !== null) applied.push(colors.background);
      },
    } as unknown as WTerm;
    const stream: RefObject<TerminalStream | null> = { current: null };
    const appearance = fakeAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", dark: "night" });
    const frames = fakeFrames();
    const deps: PaletteRefreshDeps = {
      appearance,
      schedule: frames.schedule,
      readColors: () => makeColors(currentBg),
      readFacts: () => ({ fg: null, bg: null, cursor: null }),
    };

    await act(async () =>
      root.render(<Probe wt={wt} config={EMPTY_CONFIG} dark stream={stream} deps={deps} onRender={() => undefined} />),
    );
    frames.flush();
    applied.length = 0;

    currentBg = 0x282a36;
    await act(async () => appearance.set({ dark: "dracula" }));
    currentBg = 0x2e3440;
    await act(async () => appearance.set({ dark: "nord" }));
    expect(frames.count()).toBe(1);
    frames.flush();
    expect(applied).toEqual([0x2e3440]);
  });
});
