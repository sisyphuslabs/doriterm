import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { actionFor } from "../keys/actions.ts";
import { availableActions } from "./shell-actions.ts";
import { layout, noop, pane, spaces, terminal } from "./shell-actions.fixture.ts";
import { desktopActions } from "./use-app-actions.ts";

const ACTION = "agent.waiting";
const blocked = (address: string): Terminal => ({ ...terminal(address), status: { state: "blocked" } });
const listed = (shell: "desktop" | "phone", waiting: boolean) =>
  availableActions(shell, true, null, { keys: [], active: null }, waiting).some(({ id }) => id === ACTION);

const handler = (terminals: readonly Terminal[], focused: string, opened: string[]) =>
  desktopActions(
    {
      terminals,
      layout: { ...layout, focused: { ...pane, address: focused }, placeTerminal: (address) => opened.push(address) },
      ...spaces(),
      onNew: noop,
      onNewSpace: noop,
      onSplit: noop,
      onCloseTab: noop,
      onClosePane: noop,
      onRenameTab: noop,
      onToggleSidebar: noop,
      onFocusSidebar: noop,
      onFilterSidebar: noop,
      onSession: () => true,
      onDictate: () => true,
    },
    noop,
  );

describe("the next agent that needs you, as an action (#1448)", () => {
  test("it is an app action a key can be bound to", () => {
    expect(actionFor(ACTION)?.scope).toBe("app");
  });

  test("the desktop palette lists it only while someone needs you; the phone never does", () => {
    expect(listed("desktop", true)).toBe(true);
    expect(listed("desktop", false)).toBe(false);
    expect(listed("phone", true)).toBe(false);
  });

  test("it opens each terminal that needs you in turn, and leaves the key alone when there is nowhere to go", () => {
    const opened: string[] = [];
    const terminals = [terminal("t1"), blocked("t2"), blocked("t3")];
    expect(handler(terminals, "t1", opened)(ACTION)).toBe(true);
    expect(handler(terminals, "t2", opened)(ACTION)).toBe(true);
    expect(handler(terminals, "t3", opened)(ACTION)).toBe(true);
    expect(handler([terminal("t1")], "t1", opened)(ACTION)).toBe(false);
    expect(handler([terminal("t1"), blocked("t2")], "t2", opened)(ACTION)).toBe(false);
    expect(opened).toEqual(["t2", "t3", "t2"]);
  });
});
