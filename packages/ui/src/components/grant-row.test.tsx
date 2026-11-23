import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantRow, type GrantRowProps } from "./grant-row.tsx";

const row = (props: Partial<GrantRowProps>): string =>
  renderToStaticMarkup(
    <GrantRow
      name="Work laptop"
      kind="browser"
      rights="Reads 2 spaces"
      state="active"
      ends="Ends in 12 days"
      onRemove={() => {}}
      {...props}
    />,
  );

test("only a suspended client offers Resume; every client offers Remove by its name", () => {
  expect(row({ state: "suspended", onResume: () => {} })).toContain('aria-label="Resume Work laptop"');
  for (const state of ["active", "in-use", "ended"] as const) {
    const markup = row({ state });
    expect(markup).not.toContain("Resume");
    expect(markup).toContain('aria-label="Remove Work laptop"');
  }
});

test("a suspended client says how long it sat unused before when it ends", () => {
  const markup = row({ state: "suspended", lastUsed: "Unused for 14 days" });
  expect(markup).toContain("Unused for 14 days · Ends in 12 days");
});

test("a client in use counts its sessions", () => {
  expect(row({ state: "in-use", sessions: 2 })).toContain("2 sessions");
  expect(row({ state: "active", sessions: 2 })).not.toContain("2 sessions");
});
