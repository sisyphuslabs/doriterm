import { afterEach, describe, expect, test } from "bun:test";
import { APP_ORIGIN } from "../src/config/origin.ts";
import { openPairingLink, takePairingLink } from "../src/main/deep-link.ts";
import { HcInstallError, type HcInstalled } from "@doriface/host/hc-install";
import { Channel } from "../src/shared/bridge.ts";
import { ipcHandlers, type IpcReplySender, type IpcSender } from "../src/main/ipc-handlers.ts";
import { DictationHost } from "../src/main/dictation.ts";
import { LocalHostStartError } from "../src/main/local-host.ts";
import { readNoticeAuthorization } from "../src/main/notice-authorization.ts";
import type { DesktopNotice } from "../src/shared/bridge.ts";

const endpoint = { url: "ws://127.0.0.1:1/v1/hc", token: "t".repeat(43) };
const app: IpcSender = { senderFrame: { url: "app://doriface/hosts" }, sender: { id: 7 } };
const foreign: readonly IpcSender[] = [
  { senderFrame: { url: "https://example.com/" } },
  { senderFrame: { url: "app://other/" } },
  { senderFrame: null },
];

const setup = (
  start: () => Promise<typeof endpoint> = async () => endpoint,
  choose: () => Promise<string | undefined> = async () => undefined,
  staged: { readonly version: string } | null = null,
  install: (onPhase: (phase: string) => void) => Promise<HcInstalled> = async () => {
    throw new Error("no install");
  },
  dictation?: DictationHost,
) => {
  let hcInstalls = 0;
  let chooses = 0;
  let installs = 0;
  const opened: string[] = [];
  const painted: string[] = [];
  let starts = 0;
  let closes = 0;
  const pairs: ("open" | "state")[] = [];
  const revokes: string[] = [];
  const menus: ReadonlyMap<string, string>[] = [];
  const notices: DesktopNotice[] = [];
  const targets: string[] = [];
  const background: boolean[] = [];
  const handlers = ipcHandlers({
    runInBackground: () => background.at(-1) ?? false,
    setRunInBackground: (enabled) => {
      background.push(enabled);
    },
    noticesSupported: () => true,
    noticePermission: () => readNoticeAuthorization({}, { noticeAuthorization: async () => "not-determined" }),
    showNotice: async (notice) => {
      notices.push(notice);
      return notice.kind === "test" ? { accepted: false, reason: "muted" } : { accepted: true };
    },
    setMenuKeys: (keys) => {
      menus.push(keys);
    },
    takePairingLink,
    origin: APP_ORIGIN,
    startLocalHost: async () => {
      starts += 1;
      return start();
    },
    pairOffer: async (request) => {
      pairs.push(request);
      return { state: "none" };
    },
    pairedDevices: async () => ({ state: "listed", devices: [] }),
    revokeDevice: async (id) => {
      revokes.push(id);
      return { state: "not-found", devices: [] };
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    setWindowBackground: (color) => {
      painted.push(color);
    },
    closeWindow: () => {
      closes += 1;
    },
    chooseHc: async () => {
      chooses += 1;
      return choose();
    },
    takeUpdate: () => staged,
    installUpdate: () => {
      installs += 1;
      return staged !== null;
    },
    installHc: async (onPhase) => {
      hcInstalls += 1;
      return install(onPhase);
    },
    forwardDirect: async (windowId, directUrl) => {
      targets.push(directUrl);
      return { url: `ws://127.0.0.1:1/${windowId}` };
    },
    cancelDirectForward: () => true,
    dictation,
  });
  return {
    handlers,
    opened,
    painted,
    menus,
    notices,
    pairs,
    revokes,
    targets,
    background,
    starts: () => starts,
    closes: () => closes,
    chooses: () => chooses,
    installs: () => installs,
    hcInstalls: () => hcInstalls,
  };
};

/** The app frame, with the replies it was sent on its own channels. */
const replying = (): { event: IpcReplySender; sent: unknown[][] } => {
  const sent: unknown[][] = [];
  return { event: { ...app, sender: { id: 7, send: (...args: unknown[]) => void sent.push(args) } }, sent };
};

afterEach(() => void takePairingLink());

describe("IPC sender gate", () => {
  test("refuses foreign and detached frames before touching the shell or the host", async () => {
    const { handlers, opened, notices, starts, installs, background } = setup(undefined, undefined, {
      version: "0.2.0",
    });
    openPairingLink("#p=waiting");
    await Promise.all(
      foreign.flatMap((event) => [
        expect(handlers.openExternal(event, "https://github.com/")).rejects.toThrow("refused IPC"),
        expect(handlers.openLink(event, "https://example.com/")).rejects.toThrow("refused IPC"),
        expect(handlers.startLocalHost(event)).rejects.toThrow("refused IPC"),
        expect(handlers.pairOffer(event, "open")).rejects.toThrow("refused IPC"),
        expect(handlers.pairedDevices(event)).rejects.toThrow("refused IPC"),
        expect(handlers.revokeDevice(event, "3FA94C0E")).rejects.toThrow("refused IPC"),
        expect(handlers.setWindowBackground(event, "#131518")).rejects.toThrow("refused IPC"),
        expect(handlers.closeWindow(event)).rejects.toThrow("refused IPC"),
        expect(handlers.runInBackground(event)).rejects.toThrow("refused IPC"),
        expect(handlers.setRunInBackground(event, true)).rejects.toThrow("refused IPC"),
        expect(handlers.setMenuKeys(event, { "tab.new": "super+t" })).rejects.toThrow("refused IPC"),
        expect(handlers.chooseHc(event)).rejects.toThrow("refused IPC"),
        expect(handlers.installUpdate(event)).rejects.toThrow("refused IPC"),
        expect(handlers.noticesSupported(event)).rejects.toThrow("refused IPC"),
        expect(handlers.noticePermission(event)).rejects.toThrow("refused IPC"),
        expect(handlers.showNotice(event, { kind: "done", terminal: "t1" })).rejects.toThrow("refused IPC"),
        expect(handlers.forwardDirect(event, "127.0.0.1:7767")).rejects.toThrow("refused IPC"),
        expect(handlers.cancelDirectForward(event, "ws://127.0.0.1:1/cap")).rejects.toThrow("refused IPC"),
      ]),
    );
    expect(notices).toEqual([]);
    expect(background).toEqual([]);
    for (const event of foreign) expect(() => handlers.takePairingLink(event)).toThrow("refused IPC");
    for (const event of foreign) expect(() => handlers.takeUpdate(event)).toThrow("refused IPC");
    expect(installs()).toBe(0);
    expect(opened).toEqual([]);
    expect(starts()).toBe(0);
    expect(handlers.takePairingLink(app)).toBe("#p=waiting");
  });

  test("the page reads the staged update and asks to restart into it; with none staged it reads null", async () => {
    const staged = setup(undefined, undefined, { version: "0.2.0" });
    expect(staged.handlers.takeUpdate(app)).toEqual({ version: "0.2.0" });
    expect(await staged.handlers.installUpdate(app)).toBe(true);
    expect(staged.installs()).toBe(1);
    const none = setup();
    expect(none.handlers.takeUpdate(app)).toBeNull();
    expect(await none.handlers.installUpdate(app)).toBe(false);
  });

  test("Choose hc answers the chosen file, or null when the dialog is cancelled", async () => {
    const picked = setup(undefined, async () => "/opt/herdr/hc");
    expect(await picked.handlers.chooseHc(app)).toBe("/opt/herdr/hc");
    expect(await setup().handlers.chooseHc(app)).toBeNull();
    expect(picked.chooses()).toBe(1);
  });

  test("Install herdr-core sends each phase to the page and answers the installed hc, or its failure as a value", async () => {
    const done = setup(undefined, undefined, null, async (onPhase) => {
      onPhase("download");
      onPhase("verify");
      return { version: "0.1.18", path: "/h/.local/bin/herdr-core", action: "installed" };
    });
    const page = replying();
    expect(await done.handlers.installHc(page.event)).toEqual({
      installed: { version: "0.1.18", path: "/h/.local/bin/herdr-core" },
    });
    expect(page.sent).toEqual([
      [Channel.hcInstallPhase, "download"],
      [Channel.hcInstallPhase, "verify"],
    ]);
    const damaged = setup(undefined, undefined, null, async () => {
      throw new HcInstallError("verify", "the download is damaged (checksum mismatch)");
    });
    expect(await damaged.handlers.installHc(replying().event)).toEqual({
      failed: { phase: "verify", message: "the download is damaged (checksum mismatch)" },
    });
    await expect(setup().handlers.installHc(replying().event)).rejects.toThrow("no install");
    const foreignFrame = { ...replying().event, senderFrame: { url: "https://example.com/" } };
    const refused = setup();
    await expect(refused.handlers.installHc(foreignFrame)).rejects.toThrow("refused IPC");
    expect(refused.hcInstalls()).toBe(0);
  });

  test("the Shell menu takes only its own actions and short trigger text from the page, entry by entry", async () => {
    const { handlers, menus } = setup();
    expect(await handlers.setMenuKeys(app, { "pane.split:right": "super+d", "pane.go:up": "super+alt+up" })).toBe(true);
    // One entry the menu cannot take is left out; the rest still reach the menu.
    expect(await handlers.setMenuKeys(app, { "app.quit": "super+q", "tab.new": "super+t" })).toBe(true);
    expect(await handlers.setMenuKeys(app, { "tab.new": "super+t\nRole: quit", "tab.close": "super+alt+w" })).toBe(
      true,
    );
    expect(await handlers.setMenuKeys(app, ["tab.new"])).toBe(false);
    expect(menus).toEqual([
      new Map([
        ["pane.split:right", "super+d"],
        ["pane.go:up", "super+alt+up"],
      ]),
      new Map([["tab.new", "super+t"]]),
      new Map([["tab.close", "super+alt+w"]]),
    ]);
  });

  test("the app origin takes a waiting pairing link once", () => {
    const { handlers } = setup();
    openPairingLink("#p=waiting");
    expect(handlers.takePairingLink(app)).toBe("#p=waiting");
    expect(handlers.takePairingLink(app)).toBeNull();
  });

  test("the app origin opens only normalized allowlisted links", async () => {
    const { handlers, opened } = setup();
    expect(await handlers.openExternal(app, "https://GitHub.com/x/../sisyphuslabs")).toBe(true);
    const refused = await Promise.all(
      ["https://example.com/", "http://github.com/", 42, undefined].map((candidate) =>
        handlers.openExternal(app, candidate),
      ),
    );
    expect(refused).toEqual([false, false, false, false]);
    expect(opened).toEqual(["https://github.com/sisyphuslabs"]);
  });

  test("the app origin can start the local host", async () => {
    const { handlers, starts } = setup();
    expect(await handlers.startLocalHost(app)).toBe(endpoint);
    expect(starts()).toBe(1);
  });

  test("a host that did not start answers with its failure as a value; any other error still rejects", async () => {
    const failure = { code: "hc-binary-missing", message: "not found", path: "/x/hc", details: "raw" };
    const failed = setup(async () => Promise.reject(new LocalHostStartError(failure)));
    expect(await failed.handlers.startLocalHost(app)).toEqual({ failure });
    const broken = setup(async () => Promise.reject(new Error("bug")));
    await expect(broken.handlers.startLocalHost(app)).rejects.toThrow("bug");
  });

  test("the app origin can set the window background to a hex colour and nothing else", async () => {
    const { handlers, painted } = setup();
    expect(await handlers.setWindowBackground(app, "#131518")).toBe(true);
    const refused = await Promise.all(
      ["red", "#13151", "#1315189", "url(x)", 42, undefined].map((candidate) =>
        handlers.setWindowBackground(app, candidate),
      ),
    );
    expect(refused).toEqual([false, false, false, false, false, false]);
    expect(painted).toEqual(["#131518"]);
  });

  test("a native notification takes a known kind and a terminal address, never text of its own, and answers as the OS did", async () => {
    const { handlers, notices } = setup();
    expect(await handlers.noticesSupported(app)).toBe(true);
    expect(await handlers.noticePermission(app)).toBe("not-determined");
    expect(await handlers.showNotice(app, { kind: "done", terminal: "box/t7", body: "rm -rf" })).toEqual({
      accepted: true,
    });
    expect(await handlers.showNotice(app, { kind: "test", terminal: null })).toEqual({
      accepted: false,
      reason: "muted",
    });
    const refused = [
      { kind: "done" },
      { kind: "shout", terminal: "t1" },
      { kind: "done", terminal: "" },
      { kind: "done", terminal: "t".repeat(161) },
      { kind: "done", terminal: 7 },
      "done",
      null,
    ];
    for (const answer of await Promise.all(refused.map((candidate) => handlers.showNotice(app, candidate)))) {
      expect(answer.accepted).toBe(false);
    }
    expect(notices).toEqual([
      { kind: "done", terminal: "box/t7" },
      { kind: "test", terminal: null },
    ]);
  });

  test("a native notification carries what the page knows about its terminal only as bounded, named fields (#1908)", async () => {
    const { handlers, notices } = setup();
    const context = { machine: "box", agent: "claude\u0007", ask: "q".repeat(500), title: "Your password expired" };
    expect(await handlers.showNotice(app, { kind: "input", terminal: "box/t7", context })).toEqual({ accepted: true });
    expect(await handlers.showNotice(app, { kind: "done", terminal: "t1", context: "rm -rf" })).toEqual({
      accepted: true,
    });
    expect(notices).toEqual([
      { kind: "input", terminal: "box/t7", context: { machine: "box", agent: "claude", ask: `${"q".repeat(159)}…` } },
      { kind: "done", terminal: "t1" },
    ]);
  });

  test("the app origin reads and sets Keep running in the background with a boolean and nothing else", async () => {
    const { handlers, background } = setup();
    expect(await handlers.runInBackground(app)).toBe(false);
    expect(await handlers.setRunInBackground(app, true)).toBe(true);
    expect(await handlers.runInBackground(app)).toBe(true);
    const refused = await Promise.all(
      ["true", 1, null, undefined, { enabled: true }].map((candidate) => handlers.setRunInBackground(app, candidate)),
    );
    expect(refused).toEqual([false, false, false, false, false]);
    expect(await handlers.setRunInBackground(app, false)).toBe(true);
    expect(background).toEqual([true, false]);
  });

  test("the app origin can ask its window to close", async () => {
    const { handlers, closes } = setup();
    await handlers.closeWindow(app);
    expect(closes()).toBe(1);
  });

  test("a terminal link opens any http, https or mailto target in the system browser, and nothing else", async () => {
    const { handlers, opened } = setup();
    expect(await handlers.openLink(app, "https://anywhere.example/a b")).toBe(true);
    expect(await handlers.openLink(app, "http://plain.example")).toBe(true);
    expect(await handlers.openLink(app, "mailto:me@example.com")).toBe(true);
    const refused = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "vscode://open",
      "https://user:pw@example.com/",
      "not a url",
      42,
    ];
    expect(await Promise.all(refused.map((candidate) => handlers.openLink(app, candidate)))).toEqual(
      refused.map(() => false),
    );
    expect(opened).toEqual(["https://anywhere.example/a%20b", "http://plain.example/", "mailto:me@example.com"]);
  });

  test("the app origin can ask for this computer's pairing offer, and only for the two known requests", async () => {
    const { handlers, pairs } = setup();
    expect(await handlers.pairOffer(app, "open")).toEqual({ state: "none" });
    expect(await handlers.pairOffer(app, "state")).toEqual({ state: "none" });
    expect(pairs).toEqual(["open", "state"]);
    const refused = ["pair", "", null, 7, { request: "open" }];
    expect(await Promise.all(refused.map((candidate) => handlers.pairOffer(app, candidate)))).toEqual(
      refused.map(() => null),
    );
    expect(pairs).toEqual(["open", "state"]);
  });

  test("a revoke takes a short device id only, so a hand-edited page cannot address a path", async () => {
    const { handlers, revokes } = setup();
    expect(await handlers.revokeDevice(app, "3fa94c0e")).toEqual({ state: "not-found", devices: [] });
    expect(revokes).toEqual(["3FA94C0E"]);
    const refused = ["3FA94C0", "3FA94C0E1", "../../etc/passwd", "3FA9 4C0E", "", null, 7, { id: "3FA94C0E" }];
    expect(await Promise.all(refused.map((candidate) => handlers.revokeDevice(app, candidate)))).toEqual(
      refused.map(() => null),
    );
    expect(revokes).toEqual(["3FA94C0E"]);
  });
});

const speechAddon = () => {
  const started: string[] = [];
  return {
    started,
    ready: () => true,
    speechStatus: () => "granted",
    requestSpeech: async () => "granted",
    supportsOnDevice: () => true,
    start: (lang: string) => started.push(lang),
    stop: () => undefined,
    abort: () => undefined,
  };
};

describe("direct forward over IPC (#449)", () => {
  test("each request names its own address, and anything but a string is refused before the shell (#1499)", async () => {
    const { handlers, targets } = setup();
    expect(await handlers.forwardDirect(app, "ws://192.0.2.1:7767/v1/e2ee")).toEqual({ url: "ws://127.0.0.1:1/7" });
    expect(await handlers.forwardDirect(app, "ws://192.0.2.2:7767/v1/e2ee")).toEqual({ url: "ws://127.0.0.1:1/7" });
    expect(await handlers.forwardDirect(app, 7)).toEqual({ refused: "no direct address to forward to" });
    expect(targets).toEqual(["ws://192.0.2.1:7767/v1/e2ee", "ws://192.0.2.2:7767/v1/e2ee"]);
  });
});

describe("dictation over IPC (#726)", () => {
  const page = { ...app, sender: { id: 7, isDestroyed: () => false, send: () => undefined } };

  test("foreign and detached frames are refused before the microphone is touched", async () => {
    const speech = speechAddon();
    const { handlers } = setup(
      undefined,
      undefined,
      null,
      undefined,
      new DictationHost(speech, {
        status: () => "granted",
        ask: async () => true,
      }),
    );
    await Promise.all(
      foreign.flatMap((event) => {
        const owner = { ...event, sender: page.sender };
        return [
          expect(handlers.dictationAvailable(event, "en-US")).rejects.toThrow("refused IPC"),
          expect(handlers.dictationStart(owner, "en-US")).rejects.toThrow("refused IPC"),
          expect(handlers.dictationStop(owner, 1)).rejects.toThrow("refused IPC"),
          expect(handlers.dictationAbort(owner, 1)).rejects.toThrow("refused IPC"),
        ];
      }),
    );
    expect(speech.started).toEqual([]);
    expect(await handlers.dictationStart(page, "en-US")).toEqual({ session: 1 });
    expect(speech.started).toEqual(["en-US"]);
  });

  test("a build without the system recognizer answers no and refuses every start", async () => {
    const { handlers } = setup();
    expect(await handlers.dictationAvailable(app, "en-US")).toBe(false);
    expect(await handlers.dictationStart(page, "en-US")).toEqual({ refused: "service" });
    expect(await handlers.dictationStop(page, 1)).toBe(false);
  });
});
