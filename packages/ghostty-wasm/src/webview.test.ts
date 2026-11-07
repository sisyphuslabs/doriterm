import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghosttyBuild, ghosttyWasmUrl } from "./index.ts";

const PAGE = '<!doctype html><meta charset="utf-8"><script type="module" src="/app.js"></script>';
const WASM_HEADERS = { "content-type": "application/wasm" };
/** navigate() can settle before the module script runs, so wait for the entry to publish its result. */
const AWAIT_SCENARIO = `new Promise((resolve) => {
  if ("ghosttyScenario" in globalThis) resolve(globalThis.ghosttyScenario);
  else addEventListener("ghostty-scenario", () => resolve(globalThis.ghosttyScenario), { once: true });
})`;
const PROGRAM_STATUS_REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "testing/browser-entry.ts")],
    target: "browser",
  });
  const app = bundle.outputs[0];
  if (!bundle.success || app === undefined) throw new AggregateError(bundle.logs, "browser bundle failed");
  const script = await app.text();
  const stock = Bun.resolveSync("@wterm/ghostty/ghostty-vt.wasm", import.meta.dir);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/": new Response(PAGE, { headers: { "content-type": "text/html" } }),
      "/app.js": new Response(script, { headers: { "content-type": "text/javascript" } }),
      "/ours.wasm": new Response(Bun.file(fileURLToPath(ghosttyWasmUrl)), { headers: WASM_HEADERS }),
      "/stock.wasm": new Response(Bun.file(stock), { headers: WASM_HEADERS }),
    },
  });
});

afterAll(async () => {
  await server?.stop(true);
});

describe("@wterm/ghostty 0.5.9 core on the rebuilt wasm (browser)", () => {
  test("runs the scenario in a real page against the rebuilt and the stock wasm", async () => {
    if (server === undefined) throw new Error("server did not start");
    await using view = new Bun.WebView({ width: 800, height: 600 });
    await view.navigate(server.url.href);
    const result = await view.evaluate(AWAIT_SCENARIO);
    console.log(`webview scenario: ${JSON.stringify(result)}`);

    expect(result).toMatchObject({
      ours: {
        lines: ["hello ghostty", "bold red truecolor", "after status"],
        truecolorRgb: 0xff8000,
        response: PROGRAM_STATUS_REPLY,
        programStatus: { state: "working", progress: 40, app: "doriface" },
        wasmBytes: ghosttyBuild.bytes,
      },
      stock: {
        lines: ["hello ghostty", "bold red truecolor", "after status"],
        truecolorRgb: 0xff8000,
        response: null,
        programStatus: null,
      },
    });
  }, 60_000);
});
