import type { NoticePrompt, PushClientLine, PushHostLine, PushNotice } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { planClick } from "./notice-click.ts";
import { noticeDisplay } from "./notice-display.ts";

const notice = (k: PushNotice["k"]): PushNotice => ({
  v: 1,
  n: "AAAAAAAAAAAAAAAAAAAAAA",
  k,
  h: "abcdefghijklmnopqrstuvwxyz",
});
const rows = (...labels: string[]): NoticePrompt => ({
  options: labels.map((label, index) => ({ id: String(index + 1), label, declines: label === "No" })),
});

const said = (line: PushClientLine) =>
  line.t === "answer" ? `${line.id}:${line.answer}` : line.t === "choose" ? `${line.id}:option ${line.option}` : line.t;
const URL_OF = "/?notice=AAAAAAAAAAAAAAAAAAAAAA&host=abcdefghijklmnopqrstuvwxyz";

describe("what a notice shows", () => {
  test("a permission notice offers Allow and Deny; others offer no action", () => {
    expect(noticeDisplay(notice("permission")).actions.map((action) => action.action)).toEqual(["allow", "deny"]);
    expect(noticeDisplay(notice("done")).actions).toEqual([]);
  });

  test("a prompt whose rows the host named offers them, in the agent's words", () => {
    expect(noticeDisplay(notice("input"), { prompt: rows("Postgres", "SQLite") }).actions).toEqual([
      { action: "option:1", title: "Postgres" },
      { action: "option:2", title: "SQLite" },
    ]);
  });

  test("more rows than the platform shows: the first rows that do not decline, and the agent's No row last", () => {
    expect(
      noticeDisplay(notice("permission"), { prompt: rows("Yes", "Yes, and don't ask again", "No") }, 2).actions,
    ).toEqual([
      { action: "option:1", title: "Yes" },
      { action: "option:3:declines", title: "No" },
    ]);
    expect(
      noticeDisplay(notice("input"), { prompt: rows("A", "B", "C") }, 2).actions.map((action) => action.title),
    ).toEqual(["A", "B"]);
  });

  test("a question with no rows to offer (several steps, boxes, typed text) offers none: a tap opens the card", () => {
    expect(noticeDisplay(notice("input")).actions).toEqual([]);
    expect(noticeDisplay(notice("input")).requireInteraction).toBe(true);
  });

  test("one notification per notice id; with nothing from the host it reads the plain sentence", () => {
    const shown = noticeDisplay(notice("input"));
    expect(shown.tag).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(shown.title).toBe("Doriterm");
    expect(shown.body).toBe("An agent is waiting for your input.");
  });

  test("what the host said the notice is about names the terminal and the ask (#1908), beside the rows it offers", () => {
    const about = {
      prompt: rows("Postgres", "SQLite"),
      context: { title: "roster sync", space: "api-server", machine: "box", asks: "Which database?" },
    };
    const shown = noticeDisplay(notice("input"), about);
    expect(shown.title).toBe("roster sync \u00b7 api-server \u00b7 box");
    expect(shown.body).toBe("Needs your input: Which database?");
    expect(shown.actions.map((action) => action.title)).toEqual(["Postgres", "SQLite"]);
    expect(noticeDisplay(notice("done"), { context: { title: "roster sync" } })).toMatchObject({
      title: "roster sync",
      body: "Finished",
    });
  });

  test("a test notice keeps its own words whatever the host said", () => {
    expect(noticeDisplay(notice("test"), { context: { title: "x" } })).toMatchObject({
      title: "Doriterm",
      body: "Notifications from this host work.",
    });
  });
});

/** A host that answers every line with `reply`, recording what it was asked. */
const replies = (reply: PushHostLine) => {
  const asked: string[] = [];
  return { asked, answer: async (line: PushClientLine) => (asked.push(said(line)), reply) };
};

const unreachable = async (): Promise<PushHostLine> => {
  throw new Error("offline");
};

describe("what a tap does", () => {
  test("a tap on the notice opens its pane and answers nothing", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("", notice("permission"), host.answer)).toEqual({ open: URL_OF });
    expect(host.asked).toEqual([]);
  });

  test("Allow never answers from the notification: it opens the pane with the answer for the page to send", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("allow", notice("permission"), host.answer)).toEqual({ open: `${URL_OF}&answer=allow` });
    expect(host.asked).toEqual([]);
  });

  test("Deny that the host carried out opens nothing", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("deny", notice("permission"), host.answer)).toEqual({ open: null, answered: "t3" });
    expect(host.asked).toEqual(["AAAAAAAAAAAAAAAAAAAAAA:deny"]);
  });

  test("a stale Deny, or a host that cannot be reached, opens the pane instead", async () => {
    expect(await planClick("deny", notice("permission"), replies({ t: "stale", terminal: "t3" }).answer)).toEqual({
      open: URL_OF,
    });
    expect(await planClick("deny", notice("permission"), unreachable)).toEqual({ open: URL_OF });
  });

  test("an action on a notice that is no permission prompt answers nothing", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("deny", notice("done"), host.answer)).toEqual({ open: URL_OF });
    expect(host.asked).toEqual([]);
  });

  test("a row that does not decline never answers from the notification: the page sends it once visible", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("option:2", notice("input"), host.answer)).toEqual({ open: `${URL_OF}&answer=option:2` });
    expect(host.asked).toEqual([]);
  });

  test("the agent's No row answers from the notification, like Deny, and opens the pane if it did not go through", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("option:3:declines", notice("permission"), host.answer)).toEqual({
      open: null,
      answered: "t3",
    });
    expect(host.asked).toEqual(["AAAAAAAAAAAAAAAAAAAAAA:option 3"]);
    expect(await planClick("option:3:declines", notice("permission"), unreachable)).toEqual({ open: URL_OF });
  });

  test("a row action on a notice that asks nothing answers nothing", async () => {
    const host = replies({ t: "answered", terminal: "t3" });
    expect(await planClick("option:1", notice("done"), host.answer)).toEqual({ open: URL_OF });
    expect(host.asked).toEqual([]);
  });

  test("data that is no notice opens the app", async () => {
    expect(await planClick("allow", { title: "x" }, replies({ t: "ok" }).answer)).toEqual({ open: "/" });
  });
});
