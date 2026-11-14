import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FakeCore, terminal } from "./fake-core.test-support.ts";
import { useTerminal } from "./use-terminal.ts";

function NoFrame() {}

test("a terminal reader renders only for its own foreground event (#2607)", async () => {
  const view = { HTMLIFrameElement: NoFrame, document: { activeElement: null } };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    addEventListener() {},
    removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {}, defaultView: view },
  } as unknown as Element;
  const core = new FakeCore("terminal-render-isolation");
  core.terminals = [terminal("t1"), terminal("t2")];
  const connection = core.connection() as unknown as HcConnection;
  let renders = 0;
  let name: string | undefined;
  function Reader() {
    const entry = useTerminal(connection, "t2");
    renders += 1;
    name = entry?.foreground?.name;
    return null;
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Reader />));
    const before = renders;
    await act(async () => {
      core.feeds.at(-1)?.emit({
        type: "foreground",
        terminal: "t1",
        data: { pid: 1, name: "build-a", argv: ["build-a"], cwd: "/work/a" },
      });
    });
    expect(renders - before).toBe(0);
    await act(async () => {
      core.feeds.at(-1)?.emit({
        type: "foreground",
        terminal: "t2",
        data: { pid: 2, name: "build-b", argv: ["build-b"], cwd: "/work/b" },
      });
    });
    expect(renders - before).toBe(1);
    expect(name).toBe("build-b");
  } finally {
    await act(async () => root.unmount());
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
  }
});
