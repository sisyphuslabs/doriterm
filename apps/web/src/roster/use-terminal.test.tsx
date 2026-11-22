import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { FakeCore, terminal } from "./fake-core.test-support.ts";
import { useTerminal } from "./use-terminal.ts";

function NoFrame() {}

/** Renders through react-dom into a stand-in container (the suite has no DOM), and unmounts when `run` is done. */
async function rendering(run: (render: (node: ReactNode) => Promise<void>) => Promise<void>): Promise<void> {
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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  const root = createRoot(container);
  try {
    await run((node) => act(async () => root.render(node)));
  } finally {
    await act(async () => root.unmount());
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
  }
}

const runs = (address: string, name: string) =>
  ({ type: "foreground", terminal: address, data: { pid: 1, name, argv: [name], cwd: "/work" } }) as const;

test("a terminal reader renders only for its own foreground event (#2607)", async () => {
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
  await rendering(async (render) => {
    await render(<Reader />);
    const before = renders;
    await act(async () => core.feeds.at(-1)?.emit(runs("t1", "build-a")));
    expect(renders - before).toBe(0);
    await act(async () => core.feeds.at(-1)?.emit(runs("t2", "build-b")));
    expect(renders - before).toBe(1);
    expect(name).toBe("build-b");
  });
});

test("a reader not watching renders for nothing, then reads its terminal as it stands once it watches", async () => {
  const core = new FakeCore("terminal-render-unwatched");
  core.terminals = [terminal("t1"), terminal("t2")];
  const connection = core.connection() as unknown as HcConnection;
  let renders = 0;
  let name: string | undefined;
  function Reader({ watching }: { readonly watching: boolean }) {
    const entry = useTerminal(connection, "t2", watching);
    renders += 1;
    name = entry?.foreground?.name;
    return null;
  }
  // The workspace around a pane keeps the roster's feed open whether or not the pane is watching.
  function Workspace({ watching }: { readonly watching: boolean }) {
    useTerminal(connection, "t1");
    return <Reader watching={watching} />;
  }
  await rendering(async (render) => {
    await render(<Workspace watching={false} />);
    const before = renders;
    await act(async () => core.feeds.at(-1)?.emit(runs("t2", "build-b")));
    await act(async () => core.feeds.at(-1)?.emit(runs("t2", "build-c")));
    expect(renders - before).toBe(0);
    await render(<Workspace watching />);
    expect(name).toBe("build-c");
  });
});
