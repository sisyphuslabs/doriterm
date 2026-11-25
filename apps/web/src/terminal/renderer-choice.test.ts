import { describe, expect, test } from "bun:test";
import { gpuWebgl2, isGpuRenderer, rendererChoice, terminalRenderer } from "./renderer-choice.ts";

const asked = (): boolean => {
  throw new Error("asked the browser");
};

describe("terminal renderer (#2810)", () => {
  test("unset or unknown build values choose by the browser; dom and webgl force one", () => {
    expect([undefined, "", "canvas", "dom", "webgl"].map(rendererChoice)).toEqual([
      "auto",
      "auto",
      "auto",
      "dom",
      "webgl",
    ]);
  });

  test("auto draws with WebGL on a GPU and with the DOM where WebGL2 is software or missing", () => {
    expect(terminalRenderer("auto", () => true)).toBe("webgl");
    expect(terminalRenderer("auto", () => false)).toBe("dom");
  });

  test("a forced renderer never asks the browser", () => {
    expect(terminalRenderer("dom", asked)).toBe("dom");
    expect(terminalRenderer("webgl", asked)).toBe("webgl");
  });

  test("software rasterizers are not a GPU; real GPUs and a hidden name are", () => {
    const names = [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)",
      "Apple GPU",
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "",
    ];
    expect(names.map(isGpuRenderer)).toEqual([false, false, false, true, true, true, true]);
  });

  test("without OffscreenCanvas there is no GPU WebGL2", () => {
    expect(typeof OffscreenCanvas).toBe("undefined");
    expect(gpuWebgl2()).toBe(false);
  });
});
