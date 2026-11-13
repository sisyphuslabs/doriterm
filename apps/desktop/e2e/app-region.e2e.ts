import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { join } from "node:path";
import { appRegionAt } from "./app-region.ts";
import { appDir, platformArgs } from "./launch.ts";

// appRegionAt against pages written here, in Electron's own Blink, so each case is the layout the helper meets in the
// app without launching the app (#2366).

let launched: ElectronApplication | undefined;
let page: Page | undefined;

test.beforeAll(async () => {
  launched = await electron.launch({ args: [join(appDir, "e2e", "app-region-page.cjs"), ...platformArgs] });
  page = await launched.firstWindow();
});

test.afterAll(async () => {
  await launched?.close();
});

const at = async (html: string, x: number, y: number): Promise<string> => {
  if (page === undefined) throw new Error("no window");
  await page.setContent(`<style>body{margin:0}</style>${html}`);
  return page.evaluate(appRegionAt, { x, y });
};

// A drag row 40 px high across the window; a 100 px button in it at x 100, no-drag, inside a positioned wrapper.
const row = (button: string, wrapper = "position:relative"): string => `
  <style>
    .row { -webkit-app-region: drag; height: 40px; display: flex; align-items: center; }
    .wrap { ${wrapper}; margin-left: 100px; display: flex; height: 30px; }
    button { -webkit-app-region: no-drag; width: 100px; height: 30px; border: 0; padding: 0; ${button} }
    button::after { content: ""; position: absolute; top: 0; bottom: 0; left: -6px; right: -6px; }
  </style>
  <div class="row"><div class="wrap"><button>tab</button></div></div>`;

test("a static button's absolute ::after is placed by its positioned ancestor, as the tab strip's hit layers are (#2366)", async () => {
  // #1530's hit layers: the button is static, its ::after is absolute, and the tab item around it is positioned. The
  // ::after inherits no-drag and reaches 6 px past each side of the wrapper.
  expect(await at(row(""), 150, 20), "the button's middle").toBe("no-drag");
  expect(await at(row(""), 97, 20), "inside the hit layer, left of the button").toBe("no-drag");
  expect(await at(row(""), 203, 20), "inside the hit layer, right of the button").toBe("no-drag");
  expect(await at(row(""), 80, 20), "past the hit layer, in the drag row").toBe("drag");
});

test("an absolute ::after whose own element is positioned still reads from that element", async () => {
  expect(await at(row("position:relative"), 97, 20)).toBe("no-drag");
  expect(await at(row("position:relative"), 80, 20)).toBe("drag");
});

test("a transformed ancestor is the containing block too", async () => {
  const html = row("", "transform:translateX(0)");
  expect(await at(html, 97, 20)).toBe("no-drag");
  expect(await at(html, 80, 20)).toBe("drag");
});

test("an individual translate makes the containing block too, as the tab item's inline translate does", async () => {
  const html = row("", "translate:0 0");
  expect(await at(html, 97, 20)).toBe("no-drag");
  expect(await at(html, 80, 20)).toBe("drag");
});

test("a scrolled containing block moves its ::after by the scroll", async () => {
  // The button scrolls out of view; its ::after, placed at 250 in the strip, is on screen at 150 once scrolled by 100.
  const html = `
    <style>
      .row { -webkit-app-region: drag; height: 40px; }
      .strip { position: relative; width: 200px; height: 30px; overflow-x: scroll; white-space: nowrap; }
      button { -webkit-app-region: no-drag; width: 50px; height: 20px; border: 0; padding: 0; }
      button::after { content: ""; position: absolute; left: 250px; top: 0; width: 20px; height: 20px; }
      .spacer { display: inline-block; width: 400px; height: 1px; }
    </style>
    <div class="row"><div class="strip"><button>b</button><span class="spacer"></span></div></div>`;
  if (page === undefined) throw new Error("no window");
  await page.setContent(`<style>body{margin:0}</style>${html}`);
  await page.evaluate(() => {
    const strip = document.querySelector(".strip");
    if (strip !== null) strip.scrollLeft = 100;
  });
  expect(await page.evaluate(appRegionAt, { x: 160, y: 10 }), "the scrolled ::after").toBe("no-drag");
  expect(await page.evaluate(appRegionAt, { x: 260, y: 10 }), "where it sits unscrolled").toBe("drag");
});

test("an absolute ::after with no positioned ancestor is placed against the page", async () => {
  const html = `
    <style>
      .row { -webkit-app-region: drag; height: 40px; }
      button { -webkit-app-region: no-drag; margin-left: 300px; width: 50px; height: 30px; border: 0; padding: 0; }
      button::after { content: ""; position: absolute; left: 10px; top: 0; width: 20px; height: 20px; }
    </style>
    <div class="row"><button>b</button></div>`;
  expect(await at(html, 15, 10), "the ::after, at the page's top left").toBe("no-drag");
  expect(await at(html, 100, 20), "the drag row beside it").toBe("drag");
});

test("an absolute ::after whose containing block is an inline box is still refused", async () => {
  const html = `
    <style>
      .row { -webkit-app-region: drag; height: 40px; }
      span { position: relative; }
      i { -webkit-app-region: no-drag; display: inline-block; width: 20px; height: 20px; }
      i::after { content: ""; position: absolute; left: 0; top: 0; width: 5px; height: 5px; }
    </style>
    <div class="row"><span>text <i></i> text</span></div>`;
  await expect(at(html, 5, 5)).rejects.toThrow(/no readable box/);
});
