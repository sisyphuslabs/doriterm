import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TerminalHandle } from "@wterm/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { regainingFocus, type TerminalPort, useTerminalPort } from "./terminal-port.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, and the port reads its field's page.
// These stand in for exactly what is read, and are taken away after each test.
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

/** A phone terminal's focused field, whose page records the listeners a press puts on it. */
function phoneTerminal() {
  const listeners = new Map<string, unknown>();
  const field = {
    isConnected: true,
    inputMode: "none",
    ownerDocument: {
      activeElement: null as unknown,
      defaultView: {
        addEventListener: (type: string, listener: unknown): void => void listeners.set(type, listener),
        removeEventListener: (type: string, listener: unknown): void => {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      },
      elementFromPoint: (): null => null,
    },
    blur: (): void => {
      field.ownerDocument.activeElement = null;
    },
  };
  field.ownerDocument.activeElement = field;
  const terminal = {
    instance: { element: { querySelector: () => field }, takeComposition: () => "" },
    focus: (): void => {
      field.ownerDocument.activeElement = field;
    },
  };
  const handle: { current: TerminalHandle | null } = { current: terminal as unknown as TerminalHandle };
  return { handle, field, listeners };
}

const send = (): void => undefined;
/** The port the view hands out last, as its onPort hears it. */
function seenPort() {
  const seen: { port: TerminalPort | null } = { port: null };
  const onPort = (next: TerminalPort | null): void => {
    seen.port = next;
  };
  return { seen, onPort };
}
const pasteFiles = (): void => undefined;

function Port(props: {
  readonly handle: { current: TerminalHandle | null };
  readonly onPort: (port: TerminalPort | null) => void;
  readonly softKeyboard: boolean;
}) {
  useTerminalPort(props.handle, send, props.onPort, pasteFiles, props.softKeyboard);
  return null;
}

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  root = createRoot(container);
});

afterEach(() => {
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
});

describe("a terminal view's port across a press (#2048)", () => {
  test("a terminal unmounted mid-press leaves no listener on the window and no field marked", async () => {
    const { handle, field, listeners } = phoneTerminal();
    const { seen, onPort } = seenPort();
    await act(async () => root.render(<Port handle={handle} onPort={onPort} softKeyboard />));
    seen.port?.letGo(undefined, 1);
    expect(listeners.size).toBe(4);
    expect(regainingFocus(field as unknown as EventTarget)).toBe(true);
    // The pane goes, and its terminal with it.
    field.isConnected = false;
    handle.current = null;
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    expect(field.ownerDocument.activeElement).toBe(null);
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
  });

  test("a new onPort alone keeps the press; a port the view replaces mid-press gives its field the focus back", async () => {
    const { handle, field, listeners } = phoneTerminal();
    const first = seenPort();
    await act(async () => root.render(<Port handle={handle} onPort={first.onPort} softKeyboard />));
    const holding = first.seen.port;
    holding?.letGo(undefined, 1);
    const second = seenPort();
    await act(async () => root.render(<Port handle={handle} onPort={second.onPort} softKeyboard />));
    expect(second.seen.port).toBe(holding);
    expect(listeners.size).toBe(4);
    await act(async () => root.render(<Port handle={handle} onPort={second.onPort} softKeyboard={false} />));
    expect(second.seen.port).not.toBe(holding);
    expect(listeners.size).toBe(0);
    expect(field.ownerDocument.activeElement).toBe(field);
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    await act(async () => root.unmount());
  });
});
