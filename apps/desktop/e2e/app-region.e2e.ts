import { _electron as electron, expect, test } from "@playwright/test";
import { join } from "node:path";
import { appRegionAt } from "./app-region.ts";
import { appDir } from "./launch.ts";

// appRegionAt places an absolute pseudo-element by its containing block, as Blink does (#2366): a static button's hit
// layer (#1530) is placed by the nearest positioned ancestor, not refused. A plain Electron window, not the app, so only
// the helper is under test.
const BROWSER_APP = join(appDir, "e2e", "browser-window.cjs");

const PAGE = `<!doctype html><style>
  body { margin: 0; }
  #strip { position: relative; margin: 40px 0 0 60px; width: 400px; height: 40px; -webkit-app-region: drag; }
  #tab { display: block; margin-left: 100px; width: 80px; height: 40px; -webkit-app-region: no-drag; }
  #tab::after { content: ""; position: absolute; left: 10px; top: 0; width: 20px; height: 40px; }
  #moved { margin-top: 160px; transform: translateX(300px); width: 100px; height: 40px; }
  #moved button { display: block; width: 40px; height: 40px; -webkit-app-region: drag; }
  #moved button::after { content: ""; position: absolute; left: 50px; top: 0; width: 20px; height: 40px; -webkit-app-region: no-drag; }
</style><div id="strip"><button id="tab">tab</button></div><div id="moved"><button>moved</button></div>`;

test("a static button's absolute hit layer is read against its nearest positioned or transformed ancestor (#2366)", async () => {
  const app = await electron.launch({ args: [BROWSER_APP] });
  try {
    const page = await app.firstWindow();
    await page.setContent(PAGE);
    // The strip's padding box starts at (60, 40): the layer spans x 70..90, left of the button itself (x 160..240).
    expect(await page.evaluate(appRegionAt, { x: 80, y: 60 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 120, y: 60 })).toBe("drag");
    expect(await page.evaluate(appRegionAt, { x: 200, y: 60 })).toBe("no-drag");
    // A static but transformed ancestor is a containing block too: #moved sits at x 300..400, y 240..280, and its
    // button's layer at x 350..370.
    expect(await page.evaluate(appRegionAt, { x: 360, y: 260 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 320, y: 260 })).toBe("drag");
  } finally {
    await app.close();
  }
});
