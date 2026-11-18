import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { MemberConnections, summarizeMembers } from "./members-section.tsx";

const member = (hostId: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({
    target: { hostId, hostName: hostId },
    state:
      phase === "failed" ? { phase, error: new Error("down"), retryInMs: 1_000, retryAt: 0, stale: null } : { phase },
  }) as unknown as MemberEntry;

const twoMembers = [member("a", "open"), member("b", "failed")];

describe("the machines list keeps a row per member (#942 stage 6)", () => {
  test("the summary counts the two members it is given and the one that reads connected", () => {
    const summary = summarizeMembers(twoMembers);
    expect(summary.total).toBe(2);
    expect(summary.open).toBe(1);
  });

  test("the list shows from two machines, and one machine alone is not a list worth showing", () => {
    expect(summarizeMembers([member("a", "open")]).listed).toBe(false);
    expect(summarizeMembers(twoMembers).listed).toBe(true);
  });

  test("two members draw one list, named for a screen reader beside the Machines list under it (#1170)", () => {
    const html = renderToStaticMarkup(<MemberConnections members={twoMembers} />);
    expect(html).toContain('aria-label="Connections"');
    expect(html.match(/<li[ >]/gu)).toHaveLength(2);
  });
});
