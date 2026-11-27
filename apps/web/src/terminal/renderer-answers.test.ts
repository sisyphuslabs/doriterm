import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";

/**
 * The installed (patched) @wterm/dom: what its field gives as it gains or loses focus, and what WTerm hands on. Its
 * focus report is the terminal's own answer, kept apart from typed input (`onAnswer`); a syllable still composing when
 * the field loses focus is the person's, sent as typed (#2794). input.js and wterm.js are loaded by path, as in
 * composition-cells.test.ts, and the field is built around stand-ins for the few DOM calls it makes, so no DOM is needed.
 */
const dist = dirname(Bun.resolveSync("@wterm/dom", import.meta.dir));
const { InputHandler } = (await import(join(dist, "input.js"))) as {
  InputHandler: new (
    element: object,
    onData: (data: string, preserveScroll?: boolean, answer?: boolean) => void,
    getBridge: () => object,
  ) => object;
};
const { WTerm } = (await import(join(dist, "wterm.js"))) as { WTerm: { prototype: object } };

const added = ["document", "MutationObserver"] as const;
afterEach(() => {
  for (const name of added) Reflect.deleteProperty(globalThis, name);
});

/** A stand-in node: attributes, a style, children and listeners, enough for the field and its accessibility layer. */
function node() {
  const listeners = new Map<string, ((event: object) => void)[]>();
  const self = {
    style: {} as Record<string, string>,
    classList: { add: () => undefined, remove: () => undefined, contains: () => false, toggle: () => false },
    value: "",
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    getAttribute: () => null,
    hasAttribute: () => false,
    getRootNode: () => ({ querySelector: () => null }),
    appendChild: (child: object) => child,
    removeChild: () => undefined,
    append: () => undefined,
    remove: () => undefined,
    contains: () => false,
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    addEventListener: (type: string, listener: (event: object) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: () => undefined,
    setSelectionRange: () => undefined,
    focus: () => undefined,
    blur: () => undefined,
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener({ type });
    },
    ownerDocument: {
      defaultView: {
        matchMedia: () => ({ matches: false }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      createElement: () => node(),
    },
  };
  return self;
}

function field() {
  Object.assign(globalThis, {
    document: { createElement: () => node() },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
  });
  const root = node();
  const given: [string, boolean][] = [];
  const handler = new InputHandler(
    root,
    (data, _preserveScroll, answer = false) => void given.push([data, answer]),
    () => ({ focusEvents: () => true }),
  );
  const textarea = Reflect.get(handler, "textarea") as ReturnType<typeof node>;
  return { handler, textarea, given };
}

test("a syllable still composing when the field loses focus is typed input; the focus report after it is an answer", () => {
  const { handler, textarea, given } = field();
  textarea.fire("focus");
  given.splice(0);
  Reflect.set(handler, "localPreedit", "한");
  textarea.fire("blur");
  expect(given).toEqual([
    ["한", false],
    ["\u001b[O", true],
  ]);
});

test("the report as the field gains focus is an answer", () => {
  const { textarea, given } = field();
  textarea.fire("focus");
  expect(given).toEqual([["\u001b[I", true]]);
});

/** WTerm's delivery of its own answers, on an instance built from its prototype with only what the call reads. */
function wterm(onData: ((data: string) => void) | null, onAnswer: ((data: string) => void) | null) {
  const replies = ["\u001b[?62c", "\u001b[0n"];
  return Object.assign(Object.create(WTerm.prototype) as object, {
    onData,
    onAnswer,
    bridge: { getResponse: () => replies.shift() ?? null },
  });
}

test("the replies the terminal drains go to onAnswer, not onData", () => {
  const data: string[] = [];
  const answers: string[] = [];
  const term = wterm(
    (each) => void data.push(each),
    (each) => void answers.push(each),
  );
  (Reflect.get(term, "_drainResponses") as () => unknown).call(term);
  expect([data, answers]).toEqual([[], ["\u001b[?62c", "\u001b[0n"]]);
});

test("with no onAnswer, the replies still reach onData as before", () => {
  const data: string[] = [];
  const term = wterm((each) => void data.push(each), null);
  (Reflect.get(term, "_drainResponses") as () => unknown).call(term);
  expect(data).toEqual(["\u001b[?62c", "\u001b[0n"]);
});
