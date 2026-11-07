import { describe, expect, test } from "bun:test";
import { ghosttyBuild, ghosttyWasmUrl } from "./index.ts";
import { GhosttyCore } from "@wterm/ghostty";
import { runScenario, writeAll } from "./testing/scenario.ts";

const STOCK_WASM_URL = Bun.pathToFileURL(Bun.resolveSync("@wterm/ghostty/ghostty-vt.wasm", import.meta.dir)).href;
const PROGRAM_STATUS_REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

describe("@wterm/ghostty 0.5.9 core on the rebuilt wasm (headless)", () => {
  test("renders text and SGR, answers the OSC 7501 probe, and keeps the root status report", async () => {
    const ours = await runScenario(ghosttyWasmUrl);

    expect(ours.lines).toEqual(["hello ghostty", "bold red truecolor", "after status"]);
    expect(ours.boldRedFlags & 1).toBe(1);
    expect(ours.boldRedRgb).not.toBeNull();
    expect(ours.truecolorRgb).toBe(0xff8000);
    expect(ours.response).toBe(PROGRAM_STATUS_REPLY);
    expect(ours.programStatus).toEqual({ state: "working", progress: 40, app: "doriface" });
    expect(ours.wasmBytes).toBe(ghosttyBuild.bytes);
  });

  test("the stock 0.5.9 wasm renders the same grid but has no OSC 7501 support", async () => {
    const [ours, stock] = await Promise.all([runScenario(ghosttyWasmUrl), runScenario(STOCK_WASM_URL)]);

    expect(stock.lines).toEqual(ours.lines);
    expect(stock.boldRedFlags).toBe(ours.boldRedFlags);
    expect(stock.boldRedRgb).toBe(ours.boldRedRgb);
    expect(stock.truecolorRgb).toBe(ours.truecolorRgb);
    expect(stock.response).toBeNull();
    expect(stock.programStatus).toBeNull();
  });
});

test("writing to a core that takes nothing fails at once instead of waiting for a write that never comes (#1002)", async () => {
  const core = await GhosttyCore.load({ wasmPath: ghosttyWasmUrl });
  core.init(80, 24);
  core.dispose();
  // A disposed core (as one with no terminal, or no buffer for the input) returns without calling back.
  await expect(writeAll(core, "hello")).rejects.toThrow(/wrote nothing/);
});
