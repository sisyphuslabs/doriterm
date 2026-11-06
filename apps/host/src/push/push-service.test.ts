import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CLAUDE_AFTER_SCREEN,
  CLAUDE_PROMPT_SCREEN,
} from "../../../../packages/protocol/src/testing/approval-screens.ts";
import {
  CLAUDE_MULTI_SCREEN,
  CLAUDE_QUESTION_SCREEN,
  CLAUDE_STEPS_SCREEN,
} from "../../../../packages/protocol/src/testing/prompt-screens.ts";
import { verifyVapid } from "../testing/push-receiver.ts";
import { ENDPOINT, HOST_ID, type Rig, rig, statusEvent, terminal } from "../testing/push-rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const each of rigs.splice(0)) each.close();
});

async function subscribed(owner = "device-a", endpoint = ENDPOINT): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  expect(
    await r.service.subscribe(owner, { endpoint, p256dh: r.keys.p256dh, auth: r.keys.auth }, DEFAULT_PUSH_PREFS),
  ).toBe(true);
  return r;
}

const SECRET = {
  state: "blocked",
  kind: "permission",
  app: "claude",
  msg: "Run rm -rf ~/launch-codes?",
  title: "deploy-prod",
};

describe("a notice's payload", () => {
  // Long, distinctive sentinels: a two-letter one turns up by chance in the random id, signature and ciphertext.
  const MACHINE = "box-sentinel-5d1";
  const TERMINAL = "t7-sentinel-a9c";

  test("is exactly {v,n,k,h}; the status text, title, address and machine never leave the host", async () => {
    const r = await subscribed();
    r.core.terminals.set(`${MACHINE}/${TERMINAL}`, terminal(`${MACHINE}/${TERMINAL}`, SECRET));
    await r.service.event(statusEvent(TERMINAL, SECRET, MACHINE));
    expect(await r.notices()).toEqual([{ v: 1, n: expect.stringMatching(/^[\w-]{22}$/), k: "permission", h: HOST_ID }]);
    const posted = r.posted[0];
    expect(Object.keys(posted?.headers ?? {}).toSorted()).toEqual([
      "authorization",
      "content-encoding",
      "content-type",
      "ttl",
      "urgency",
    ]);
    const wire = JSON.stringify(posted?.headers) + Buffer.from(posted?.body ?? []).toString("latin1");
    for (const plain of ["launch-codes", "deploy-prod", MACHINE, TERMINAL]) expect(wire).not.toContain(plain);
  });

  test("goes to the push service with a VAPID header for that origin and an encrypted body", async () => {
    const r = await subscribed();
    await r.service.event(statusEvent("t1", { state: "done" }));
    const posted = r.posted[0];
    expect(posted?.url).toBe(ENDPOINT);
    expect(posted?.headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "high", ttl: "86400" });
    const { key, claims } = await verifyVapid(posted?.headers["authorization"] ?? "");
    expect(key).toBe(r.service.vapidKey);
    expect(claims.aud).toBe("https://fcm.googleapis.com");
  });
});

describe("who gets a notice", () => {
  test("a device focused on that terminal gets none; once its stream closes it does", async () => {
    const r = await subscribed();
    const present = r.service.presence("device-a");
    present.focus("t1");
    await r.service.event(statusEvent("t1", { state: "done" }));
    await r.service.event(statusEvent("t2", { state: "done" }));
    expect(r.posted).toHaveLength(1);
    present.leave();
    await r.service.event(statusEvent("t1", { state: "error" }));
    expect(r.posted).toHaveLength(2);
  });

  test("a turned-off event and a muted machine send nothing", async () => {
    const r = await subscribed();
    r.service.setPrefs("device-a", ENDPOINT, {
      events: { ...DEFAULT_PUSH_PREFS.events, done: false },
      muted: ["machine:box"],
    });
    await r.service.event(statusEvent("t1", { state: "done" }));
    await r.service.event(statusEvent("t2", { state: "error" }, "box"));
    expect(r.posted).toHaveLength(0);
    await r.service.event(statusEvent("t3", { state: "error" }));
    expect(r.posted).toHaveLength(1);
  });

  test("a revoked device gets nothing, even before its subscriptions are pruned", async () => {
    const r = await subscribed();
    r.paired.delete("device-a");
    await r.service.event(statusEvent("t1", { state: "done" }));
    expect(r.posted).toHaveLength(0);
  });

  test("an endpoint the push service calls gone is removed", async () => {
    const r = await subscribed();
    r.status = 410;
    await r.service.event(statusEvent("t1", { state: "done" }));
    expect(r.store.list()).toEqual([]);
  });

  test("an endpoint that is no known push service is refused at subscribe", async () => {
    const r = await rig();
    rigs.push(r);
    const keys = { p256dh: r.keys.p256dh, auth: r.keys.auth };
    const endpoints = [
      "https://example.com/push",
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
    ];
    const accepted = await Promise.all(
      endpoints.map((endpoint) => r.service.subscribe("device-a", { endpoint, ...keys }, DEFAULT_PUSH_PREFS)),
    );
    expect(accepted).toEqual(endpoints.map(() => false));
    expect(r.store.list()).toEqual([]);
  });
});

describe("answering a permission notice", () => {
  // Claude Code's own dialog (captured from a real session in #192): Allow is its key "1", Deny is Esc.
  const ASKING = { state: "blocked", kind: "permission", app: "claude-code" };

  async function noticed(): Promise<{ r: Rig; id: string }> {
    const r = await subscribed();
    r.core.terminals.set("t3", terminal("t3", ASKING));
    r.core.screens.set("t3", CLAUDE_PROMPT_SCREEN);
    await r.service.event(statusEvent("t3", ASKING));
    const [notice] = await r.notices();
    const id = typeof notice === "object" && notice !== null ? String(Reflect.get(notice, "n")) : "";
    return { r, id };
  }

  test("the notice id resolves to its terminal only on the host", async () => {
    const { r, id } = await noticed();
    expect(r.service.resolve(id)).toMatchObject({ terminal: "t3", kind: "permission" });
  });

  test("Allow sends Claude Code's own key 1 while the prompt is still on the live screen; Deny sends Esc", async () => {
    const allowed = await noticed();
    expect(await allowed.r.service.answer(allowed.id, "allow", "device-a")).toEqual({ t: "answered", terminal: "t3" });
    expect(allowed.r.core.sent).toEqual([{ terminal: "t3", keys: ["1"] }]);
    const denied = await noticed();
    expect(await denied.r.service.answer(denied.id, "deny", "device-a")).toEqual({ t: "answered", terminal: "t3" });
    expect(denied.r.core.sent).toEqual([{ terminal: "t3", keys: ["esc"] }]);
  });

  test.each([
    [
      "answered in the terminal first",
      (r: Rig) => r.core.terminals.set("t3", terminal("t3", { state: "working", app: "claude-code" })),
    ],
    [
      "a new prompt took its place",
      (r: Rig) => r.core.terminals.set("t3", terminal("t3", ASKING, { status_ms: 9_999, turn: 3 })),
    ],
    ["the dialog left the screen", (r: Rig) => r.core.screens.set("t3", CLAUDE_AFTER_SCREEN)],
  ])("stale when %s: nothing is sent", async (_, change) => {
    const { r, id } = await noticed();
    change(r);
    expect(await r.service.answer(id, "allow", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toEqual([]);
  });

  test("two racing answers send exactly one", async () => {
    const { r, id } = await noticed();
    const replies = await Promise.all([
      r.service.answer(id, "allow", "device-a"),
      r.service.answer(id, "deny", "device-b"),
    ]);
    expect(replies.map((reply) => reply.t).toSorted()).toEqual(["answered", "stale"]);
    expect(r.core.sent).toHaveLength(1);
  });

  test("two answers from one device at once (its worker's Deny and its page's Allow) send exactly one", async () => {
    const { r, id } = await noticed();
    const replies = await Promise.all([
      r.service.answer(id, "deny", "device-a"),
      r.service.answer(id, "allow", "device-a"),
    ]);
    expect(replies.map((reply) => reply.t).toSorted()).toEqual(["answered", "stale"]);
    expect(r.core.sent).toHaveLength(1);
  });

  test("a link that drops before the key press says it did not go through, with the reason logged", async () => {
    const { r, id } = await noticed();
    r.core.failScreen = new Error("terminal.read: the link dropped");
    const reply = await r.service.answer(id, "allow", "device-a");
    expect(reply).toMatchObject({ t: "failed", terminal: "t3", reason: "terminal.read: the link dropped" });
    expect(r.core.sent).toEqual([]);
    expect(r.logs.join("\n")).toContain("terminal.read: the link dropped");
  });

  test("a key press that may have landed is reported unknown, never answered or stale, and logged", async () => {
    const { r, id } = await noticed();
    r.core.failKeys = new Error("terminal.keys: the reply was lost");
    expect(await r.service.answer(id, "allow", "device-a")).toEqual({ t: "unknown", terminal: "t3" });
    expect(r.logs.join("\n")).toContain("terminal.keys: the reply was lost");
    expect(await r.service.answer(id, "allow", "device-b")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toHaveLength(1);
  });

  test("an agent this host cannot read, or an unknown id, is stale", async () => {
    const r = await subscribed();
    const other = { ...ASKING, app: "my-agent" };
    r.core.terminals.set("t5", terminal("t5", other));
    r.core.screens.set("t5", CLAUDE_PROMPT_SCREEN);
    await r.service.event(statusEvent("t5", other));
    const [notice] = await r.notices();
    const id = typeof notice === "object" && notice !== null ? String(Reflect.get(notice, "n")) : "";
    expect(await r.service.answer(id, "allow", "device-a")).toEqual({ t: "stale", terminal: "t5" });
    expect(await r.service.answer("AAAAAAAAAAAAAAAAAAAAAA", "allow", "device-a")).toEqual({
      t: "stale",
      terminal: null,
    });
    expect(r.core.sent).toEqual([]);
  });
});

describe("a notice's own rows (#669)", () => {
  const PERMISSION = { state: "blocked", kind: "permission", app: "claude-code" };
  const QUESTION = { state: "blocked", kind: "question", app: "claude-code" };

  async function noticed(status: typeof PERMISSION, screen: string): Promise<{ r: Rig; id: string }> {
    const r = await subscribed();
    r.core.terminals.set("t3", terminal("t3", status));
    r.core.screens.set("t3", screen);
    await r.service.event(statusEvent("t3", status));
    const [notice] = await r.notices();
    const id = typeof notice === "object" && notice !== null ? String(Reflect.get(notice, "n")) : "";
    return { r, id };
  }

  test("a permission notice names every row of its dialog, in the agent's words", async () => {
    const { r, id } = await noticed(PERMISSION, CLAUDE_PROMPT_SCREEN);
    expect(r.service.prompt(r.service.resolve(id))?.options).toEqual([
      { id: "1", label: "Yes", declines: false },
      { id: "2", label: "Yes, and always allow access to ~/work from this project", declines: false },
      { id: "3", label: "Yes, and switch to auto mode · auto mode handles these prompts for you", declines: false },
      { id: "4", label: "No", declines: true },
    ]);
  });

  test("a single question is an input notice that names its rows, leaving out the typed one", async () => {
    const { r, id } = await noticed(QUESTION, CLAUDE_QUESTION_SCREEN);
    expect(r.service.resolve(id)?.kind).toBe("input");
    expect(r.service.prompt(r.service.resolve(id))?.options.map((row) => row.label)).toEqual([
      "Postgres",
      "SQLite",
      "Both",
      "Chat about this",
    ]);
  });

  test.each([
    ["several questions", CLAUDE_STEPS_SCREEN],
    ["a multi-select question", CLAUDE_MULTI_SCREEN],
  ])("%s names no rows: a tap opens the card", async (_, screen) => {
    const { r, id } = await noticed(QUESTION, screen);
    expect(r.service.prompt(r.service.resolve(id))).toBeUndefined();
    expect(await r.service.choose(id, "1", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toEqual([]);
  });

  test("a row the notice named is answered with that row's own key, after the live-screen check", async () => {
    const { r, id } = await noticed(QUESTION, CLAUDE_QUESTION_SCREEN);
    expect(await r.service.choose(id, "2", "device-a")).toEqual({ t: "answered", terminal: "t3" });
    expect(r.core.sent).toEqual([{ terminal: "t3", keys: ["2"] }]);
  });

  test("a row the notice did not name (the typed one, or none at all) presses nothing", async () => {
    const { r, id } = await noticed(QUESTION, CLAUDE_QUESTION_SCREEN);
    expect(await r.service.choose(id, "4", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(await r.service.choose(id, "9", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toEqual([]);
  });

  test("a question changed in the terminal after the notice is stale: nothing is pressed", async () => {
    const { r, id } = await noticed(QUESTION, CLAUDE_QUESTION_SCREEN);
    r.core.screens.set("t3", CLAUDE_STEPS_SCREEN);
    expect(await r.service.choose(id, "1", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toEqual([]);
  });

  test("a question's notice has no Allow: Allow from an older page presses nothing", async () => {
    const { r, id } = await noticed(QUESTION, CLAUDE_QUESTION_SCREEN);
    expect(await r.service.answer(id, "allow", "device-a")).toEqual({ t: "stale", terminal: "t3" });
    expect(r.core.sent).toEqual([]);
  });
});
