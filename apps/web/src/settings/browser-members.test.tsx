import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserMemberList } from "./browser-members.tsx";

const now = 1_800_000_000_000;
const clients = [{ hostId: "browser", name: "phone-browser", signPub: "self" }];

test("a client row attributes the last accepted session to its reporting machine", () => {
  const html = renderToStaticMarkup(
    <BrowserMemberList
      clients={clients}
      self="self"
      observer="Beta"
      now={now}
      observations={[{ hostId: "browser", lastSessionAt: now - 120_000 }]}
    />,
  );
  expect(html).toContain("phone-browser (this browser)");
  expect(html).toContain("Last session on Beta: 2m ago");
  expect(html).toContain("Copy the command that removes phone-browser");
});

test("an absent timestamp is never seen here, without borrowing another client's session", () => {
  const html = renderToStaticMarkup(
    <BrowserMemberList
      clients={clients}
      self="self"
      observer="Beta"
      now={now}
      observations={[{ hostId: "browser" }, { hostId: "other", lastSessionAt: now - 120_000 }]}
    />,
  );
  expect(html).toContain("Last session on Beta: never");
  expect(html).not.toContain("2m ago");
});

test("a missing status report leaves session time unavailable rather than claiming never", () => {
  const html = renderToStaticMarkup(
    <BrowserMemberList clients={clients} self="self" observer={undefined} observations={undefined} now={now} />,
  );
  expect(html).toContain("Last session: unavailable");
  expect(html).not.toContain("never");
});
