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
  #slid { margin-top: 20px; translate: 300px 0; width: 100px; height: 40px; }
  #slid button { display: block; width: 40px; height: 40px; -webkit-app-region: drag; }
  #slid button::after { content: ""; position: absolute; left: 50px; top: 0; width: 20px; height: 40px; -webkit-app-region: no-drag; }
</style><div id="strip"><button id="tab">tab</button></div><div id="moved"><button>moved</button></div><div id="slid"><button>slid</button></div>`;

/** A positioned scroll container whose layer is read after it scrolls. */
const SCROLLED = `<!doctype html><style>
  body { margin: 0; }
  #box { position: relative; overflow: auto; width: 200px; height: 100px; -webkit-app-region: drag; }
  #box button { display: block; width: 40px; height: 300px; -webkit-app-region: drag; }
  #box button::after { content: ""; position: absolute; left: 100px; top: 70px; width: 20px; height: 10px; -webkit-app-region: no-drag; }
</style><div id="box"><button>tall</button></div>`;

/**
 * The same layer under a scaled ancestor, as the app's rows are while their entrance animation runs (#2366): #grown is
 * scaled 2x from its top-left corner, so the layer at left 0, top 50, 20x20 covers x 0..40, y 100..140 on screen.
 */
const SCALED = `<!doctype html><style>
  body { margin: 0; }
  #grown { scale: 2; transform-origin: 0 0; width: 100px; height: 40px; }
  #grown button { display: block; -webkit-app-region: no-drag; }
  #grown button::after { content: ""; position: absolute; left: 0; top: 50px; width: 20px; height: 20px; }
</style><div id="grown"><button>grown</button></div>`;

/**
 * Two scales multiplied, the inner one about its centre as the app's entrance animation scales a row: #wrap (at 100,
 * 100) is scaled 1.5 from its corner and #grown 2 about its centre, so #grown's padding box starts at x 25, y 70 and
 * its layer, at left 0, top 50, 20x20 in #grown's units, covers x 25..85, y 220..280.
 */
const NESTED = `<!doctype html><style>
  body { margin: 0; }
  #wrap { margin: 100px 0 0 100px; width: 100px; scale: 1.5; transform-origin: 0 0; }
  #grown { scale: 2; width: 100px; height: 40px; }
  #grown button { display: block; -webkit-app-region: no-drag; }
  #grown button::after { content: ""; position: absolute; left: 0; top: 50px; width: 20px; height: 20px; }
</style><div id="wrap"><div id="grown"><button>grown</button></div></div>`;

test("a static button's absolute hit layer is read against its nearest positioned or transformed ancestor (#2366)", async () => {
  const app = await electron.launch({ args: [BROWSER_APP, "--disable-gpu"] });
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
    // `translate` on its own, as Tailwind writes it, places the layer the same way: #slid sits at y 300..340.
    expect(await page.evaluate(appRegionAt, { x: 360, y: 320 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 320, y: 320 })).toBe("drag");
    // A layer in a scrolled container moves with its content: scrolled by 50, a layer at top 70 sits at y 20..30.
    await page.setContent(SCROLLED);
    await page.evaluate(() => document.getElementById("box")?.scrollTo(0, 50));
    expect(await page.evaluate(appRegionAt, { x: 105, y: 25 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 105, y: 75 })).toBe("drag");
    // Under a 2x scale the scroll offset is in the container's own units: the layer sits at x 200..240, y 40..60.
    await page.setContent(
      SCROLLED.replace("body { margin: 0; }", "body { margin: 0; scale: 2; transform-origin: 0 0; }"),
    );
    await page.evaluate(() => document.getElementById("box")?.scrollTo(0, 50));
    expect(await page.evaluate(appRegionAt, { x: 210, y: 50 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 210, y: 150 })).toBe("drag");
    // A fixed layer under a transformed scroll container is that container's, so it scrolls with its content too.
    await page.setContent(
      SCROLLED.replace("position: relative; overflow: auto;", "transform: translateX(0); overflow: auto;").replace(
        '#box button::after { content: ""; position: absolute;',
        '#box button::after { content: ""; position: fixed;',
      ),
    );
    await page.evaluate(() => document.getElementById("box")?.scrollTo(0, 50));
    expect(await page.evaluate(appRegionAt, { x: 105, y: 25 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 105, y: 75 })).toBe("drag");
    // With the root itself the containing block, the page's scroll moves the root's box once, not twice: a layer at
    // top 200 in a page scrolled by 100 sits at y 100..110.
    await page.setContent(`<!doctype html><style>
      html { position: relative; } body { margin: 0; height: 2000px; -webkit-app-region: drag; }
      #tall { display: block; width: 40px; height: 40px; -webkit-app-region: drag; }
      #tall::after { content: ""; position: absolute; left: 100px; top: 200px; width: 20px; height: 10px; -webkit-app-region: no-drag; }
    </style><button id="tall">tall</button>`);
    await page.evaluate(() => window.scrollTo(0, 100));
    expect(await page.evaluate(appRegionAt, { x: 105, y: 105 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 105, y: 205 })).toBe("drag");
    await page.setContent(SCALED);
    // The page lists no region of its own, so a point beside the layer reads none; read unscaled, the layer would sit at
    // x 0..20, y 50..70 instead.
    expect(await page.evaluate(appRegionAt, { x: 30, y: 130 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 50, y: 130 })).toBe("none");
    expect(await page.evaluate(appRegionAt, { x: 10, y: 60 })).toBe("none");
    // A scale written as a transform, the way the entrance animation writes it, and one above the containing block
    // place the layer the same way.
    await page.setContent(SCALED.replace("scale: 2;", "transform: scale(2);"));
    expect(await page.evaluate(appRegionAt, { x: 30, y: 130 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 50, y: 130 })).toBe("none");
    await page.setContent(
      SCALED.replace("body { margin: 0; }", "body { margin: 0; scale: 2; transform-origin: 0 0; }").replace(
        "#grown { scale: 2; transform-origin: 0 0;",
        "#grown { position: relative;",
      ),
    );
    expect(await page.evaluate(appRegionAt, { x: 30, y: 130 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 50, y: 130 })).toBe("none");
    await page.setContent(NESTED);
    expect(await page.evaluate(appRegionAt, { x: 30, y: 225 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 80, y: 275 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 90, y: 250 })).toBe("none");
    expect(await page.evaluate(appRegionAt, { x: 55, y: 285 })).toBe("none");
    // The inner scale written as a transform, as the app's arrival writes it, compounds with the outer scale the same way.
    await page.setContent(NESTED.replace("#grown { scale: 2;", "#grown { transform: scale(2);"));
    expect(await page.evaluate(appRegionAt, { x: 30, y: 225 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 80, y: 275 })).toBe("no-drag");
    expect(await page.evaluate(appRegionAt, { x: 90, y: 250 })).toBe("none");
    expect(await page.evaluate(appRegionAt, { x: 55, y: 285 })).toBe("none");
    // A rotation has no such product, so it is refused.
    await page.setContent(SCALED.replace("scale: 2;", "rotate: 10deg;"));
    await expect(page.evaluate(appRegionAt, { x: 10, y: 10 })).rejects.toThrow("no readable box");
  } finally {
    await app.close();
  }
});
