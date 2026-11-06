import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { BASE_UI_SCROLLBAR_STYLE_HASH, contentSecurityPolicy } from "../src/config/csp.ts";
import { allowedExternal, isAllowedExternal } from "../src/config/external.ts";
import { APP_ORIGIN, isSameOrigin, loopbackDevUrl } from "../src/config/origin.ts";
import { isGrantable } from "../src/config/permissions.ts";
import {
  DEFAULT_WINDOW_SIZE,
  launchBackground,
  MIN_WINDOW_SIZE,
  secureWebPreferences,
  TRAFFIC_LIGHT_POSITION,
  WINDOW_BACKGROUND,
  windowOptions,
} from "../src/config/window.ts";
import { VERSION_ARG } from "../src/shared/bridge.ts";

const directives = (csp: string): ReadonlyMap<string, readonly string[]> =>
  new Map(
    csp.split("; ").map((directive) => {
      const [name = "", ...sources] = directive.split(" ");
      return [name, sources] as const;
    }),
  );

describe("main process window config", () => {
  test("webPreferences isolate and sandbox the renderer", () => {
    expect(secureWebPreferences("/app/preload.cjs", "1.2.3")).toEqual({
      preload: "/app/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      additionalArguments: [`${VERSION_ARG}1.2.3`],
    });
  });

  test("the window title is the product name", () => {
    const look = { background: WINDOW_BACKGROUND.dark, placement: DEFAULT_WINDOW_SIZE };
    expect(windowOptions("darwin", secureWebPreferences("/p", "0.0.0"), look).title).toBe("Doriterm");
  });

  test("macOS gets a hidden-inset titlebar with positioned traffic lights; others keep the native frame", () => {
    const prefs = secureWebPreferences("/p", "0.0.0");
    const look = { background: WINDOW_BACKGROUND.dark, placement: DEFAULT_WINDOW_SIZE };
    const mac = windowOptions("darwin", prefs, look);
    expect(mac.titleBarStyle).toBe("hiddenInset");
    expect(mac.trafficLightPosition).toEqual({ x: TRAFFIC_LIGHT_POSITION.x, y: TRAFFIC_LIGHT_POSITION.y });
    expect(mac.webPreferences).toBe(prefs);
    for (const platform of ["linux", "win32"] as const) {
      const options = windowOptions(platform, prefs, look);
      expect(options.titleBarStyle).toBeUndefined();
      expect(options.trafficLightPosition).toBeUndefined();
      expect(options.show).toBe(false);
    }
  });

  test("the window opens hidden on its launch background, no smaller than the desktop layout", () => {
    const prefs = secureWebPreferences("/p", "0.0.0");
    const placement = { x: 40, y: 60, width: 1000, height: 700 };
    const options = windowOptions("darwin", prefs, { background: "#131518", placement });
    expect(options).toMatchObject({ ...placement, show: false, backgroundColor: "#131518" });
    expect({ width: options.minWidth, height: options.minHeight }).toEqual(MIN_WINDOW_SIZE);
    expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(768);
  });

  test("the launch background is the last in-app theme's, else the system appearance's", () => {
    expect(launchBackground({ background: "#131518" }, true)).toBe("#131518");
    expect(launchBackground(undefined, true)).toBe(WINDOW_BACKGROUND.dark);
    expect(launchBackground(undefined, false)).toBe(WINDOW_BACKGROUND.light);
    for (const bad of [null, "#131518", { background: "red" }, { background: "#13151" }, { background: 4 }]) {
      expect(launchBackground(bad, false)).toBe(WINDOW_BACKGROUND.light);
    }
  });
});

describe("content security policy", () => {
  test("production allows only same-origin scripts and styles, plus WebAssembly", () => {
    const csp = directives(contentSecurityPolicy());
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp.get("style-src")).toEqual(["'self'", BASE_UI_SCROLLBAR_STYLE_HASH]);
    for (const name of ["object-src", "frame-src", "frame-ancestors", "base-uri", "form-action"]) {
      expect(csp.get(name)).toEqual(["'none'"]);
    }
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "ws:",
      "wss:",
      "http://127.0.0.1:*",
      "http://localhost:*",
      "https://relay-doriface.omo.dev",
    ]);
    expect([...csp.values()].flat()).not.toContain("'unsafe-eval'");
    expect([...csp.values()].flat()).not.toContain("'unsafe-inline'");
  });

  test("dev mode admits Vite's inline preamble and nothing else extra", () => {
    const prod = directives(contentSecurityPolicy());
    const dev = directives(contentSecurityPolicy({ devServer: "http://localhost:5173" }));
    expect(dev.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"]);
    expect(dev.get("style-src")).toEqual(["'self'", BASE_UI_SCROLLBAR_STYLE_HASH, "'unsafe-inline'"]);
    expect([...dev.keys()]).toEqual([...prod.keys()]);
    for (const [name, sources] of prod) {
      if (name !== "script-src" && name !== "style-src") expect(dev.get(name)).toEqual(sources);
    }
  });

  test("the one allowed inline style is Base UI's scrollbar rule, hashed from the installed Base UI (#499)", async () => {
    // The package exports no utils path, so the module is loaded by file from the installed package the UI uses.
    const ui = join(import.meta.dirname, "../../../packages/ui");
    const root = dirname(Bun.resolveSync("@base-ui/react/scroll-area", ui));
    const styles: unknown = await import(join(root, "..", "utils", "styles.mjs"));
    const element = Reflect.get(Reflect.get(Object(styles), "styleDisableScrollbar"), "getElement")(undefined);
    const css: unknown = element.props.children;
    expect(typeof css).toBe("string");
    const hash = createHash("sha256").update(String(css)).digest("base64");
    expect(BASE_UI_SCROLLBAR_STYLE_HASH).toBe(`'sha256-${hash}'`);
  });
});

describe("origin, external links and permissions", () => {
  test("the app origin matches by scheme and host", () => {
    expect(isSameOrigin("app://doriface/index.html", APP_ORIGIN)).toBe(true);
    expect(isSameOrigin("app://DoriFace/index.html", APP_ORIGIN)).toBe(true);
    expect(isSameOrigin("app://evil/index.html", APP_ORIGIN)).toBe(false);
    expect(isSameOrigin("https://doriface/", APP_ORIGIN)).toBe(false);
    expect(isSameOrigin("not a url", APP_ORIGIN)).toBe(false);
  });

  test("only a loopback http dev server may become the app origin", () => {
    expect(loopbackDevUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(loopbackDevUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(loopbackDevUrl("http://[::1]:5173")).toBe("http://[::1]:5173/");
    for (const url of ["https://localhost:5173", "http://example.com:5173", "http://10.0.0.2:5173", "file:///x", "x"]) {
      expect(() => loopbackDevUrl(url)).toThrow("refusing dev server");
    }
  });

  test("only https links to exactly an allowlisted host open externally", () => {
    expect(isAllowedExternal("https://github.com/sisyphuslabs/doriterm")).toBe(true);
    expect(isAllowedExternal("https://omo.dev/x")).toBe(true);
    expect(isAllowedExternal("https://docs.omo.dev/x")).toBe(false);
    expect(isAllowedExternal("https://gist.github.com/x")).toBe(false);
    expect(isAllowedExternal("http://github.com/")).toBe(false);
    expect(isAllowedExternal("https://github.com.evil.example/")).toBe(false);
    expect(isAllowedExternal("https://user:pw@github.com/")).toBe(false);
    expect(isAllowedExternal("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternal("javascript:alert(1)")).toBe(false);
    expect(allowedExternal("https://GitHub.com/a/../sisyphuslabs")).toBe("https://github.com/sisyphuslabs");
    expect(allowedExternal("https://example.com/")).toBeUndefined();
  });

  test("permissions are denied unless the app origin asks for a clipboard write", () => {
    expect(isGrantable("clipboard-sanitized-write", "app://doriface/", APP_ORIGIN)).toBe(true);
    expect(isGrantable("clipboard-sanitized-write", "https://example.com/", APP_ORIGIN)).toBe(false);
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "openExternal"]) {
      expect(isGrantable(permission, "app://doriface/", APP_ORIGIN)).toBe(false);
    }
  });
});
