import { expect, test } from "bun:test";
import { offlineTitle } from "./machine-status.tsx";

test("a machine that needs a login is titled by its cause, not called offline (#2375 review)", () => {
  const views = [{ id: "m1", name: "box", state: "needs_login" }] as const;
  expect(offlineTitle("box", views as never)).toBe("box needs a login");
  expect(offlineTitle("gone", [])).toBe("gone is offline");
});
