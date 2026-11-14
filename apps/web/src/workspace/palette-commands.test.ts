import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { resolveKeymap } from "../keys/keymap.ts";
import type { ListedSpace } from "./model.ts";
import { choiceOf, paletteCommands, spaceNameOf } from "./palette-commands.ts";
import { availableActions, type Shell } from "./shell-actions.ts";

const terminal = (fields: Partial<Terminal>): Terminal => ({
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/doriface",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

const source = (terminals: readonly Terminal[], shell: Shell = "desktop") => ({
  actions: availableActions(shell, false),
  terminals,
  host: "studio",
  machines: ["box", "studio"],
  platform: "mac" as const,
  keymap: resolveKeymap("mac", new Map()),
});

const listed = (name: string, addresses: readonly string[]): ListedSpace => ({
  id: name,
  name,
  tabs: addresses.length,
  addresses,
  tabPanes: addresses.map((address) => [address]),
  tabNames: addresses.map(() => ""),
  tabPins: addresses.map(() => false),
  dir: "",
});

const split = (inView: boolean, readOnly: string | null = null) =>
  paletteCommands({ ...source([]), actions: availableActions("desktop", inView, readOnly) }).find(
    (command) => command.id === "pane.split:right",
  );

describe("paletteCommands", () => {
  test("lists live agents with their state, then actions, the host and settings", () => {
    const commands = paletteCommands(
      source([
        terminal({ address: "box/t1", name: "deploy", status: { state: "blocked" } }),
        terminal({ address: "t2", state: "finished" }),
      ]),
    );
    expect([...new Set(commands.map((command) => command.group))]).toEqual(["Agents", "Actions", "Hosts", "General"]);
    expect(commands.filter((command) => command.group === "Agents")).toEqual([
      {
        id: "agent:box/t1",
        label: "deploy",
        group: "Agents",
        status: "blocked",
        hint: "box",
        where: { place: "box \u203a doriface", directory: "/work/doriface" },
      },
    ]);
    expect(commands.find((command) => command.id === "tab.new")?.keys).toEqual(["⌘", "T"]);
    // Every machine is a host row, in the person's order, and none carries the route (#2534 review).
    expect(
      commands.filter((command) => command.group === "Hosts").map((command) => [command.label, command.hint]),
    ).toEqual([
      ["box", undefined],
      ["studio", undefined],
    ]);
  });

  test("names the first space an address is listed in, as the sidebar does, when two list it (#1486)", () => {
    const spaces = [listed("first", ["t4", "t1"]), listed("second", ["t1"])];
    const [agent] = paletteCommands({ ...source([terminal({ address: "t1" })]), spaceOf: spaceNameOf(spaces) });
    expect(agent?.where).toEqual({ place: "studio \u203a first", directory: "/work/doriface" });
    expect(spaceNameOf(spaces)("t9")).toBeUndefined();
  });

  test("lists Filter the sidebar with its key, as it lists the other sidebar actions (#848)", () => {
    const filter = paletteCommands(source([])).find((command) => command.id === "layout.filter:sidebar");
    expect(filter).toMatchObject({ label: "Filter the sidebar", group: "Actions" });
    expect(filter?.keys?.toSorted()).toEqual(["⌘", "⌥", "F"].toSorted());
  });

  test("agents that need you come first", () => {
    const commands = paletteCommands(
      source([
        terminal({ address: "t1", name: "shell" }),
        terminal({ address: "t2", name: "deploy", status: { state: "blocked" } }),
      ]),
    );
    expect(commands.filter((command) => command.group === "Agents").map((command) => command.label)).toEqual([
      "deploy",
      "shell",
    ]);
  });

  test("a phone's palette lists only what the phone shell handles", () => {
    const labels = paletteCommands(source([], "phone")).map((command) => command.label);
    expect(labels).toEqual([
      "New tab",
      "Larger terminal text",
      "Smaller terminal text",
      "box",
      "studio",
      "Keyboard shortcuts",
      "Open settings",
    ]);
  });

  test("split is listed as unavailable, with the reason, until a terminal whose layout takes edits is in view", () => {
    expect([split(false)?.disabled, split(false)?.hint]).toEqual([true, "No terminal to split"]);
    expect(split(true, "the layout is loading")?.hint).toBe("the layout is loading");
    expect(split(true)?.disabled).toBeUndefined();
  });

  test("each row kind parses to its choice", () => {
    expect(choiceOf("agent:box/t1")).toEqual({ kind: "agent", address: "box/t1" });
    expect(choiceOf("host:studio")).toEqual({ kind: "settings" });
    expect(choiceOf("app.settings")).toEqual({ kind: "action", id: "app.settings" });
  });
});
