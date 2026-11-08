import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { onlineInviters, InviteMachineChoice } from "./browser-invite.tsx";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import type { HcConnection } from "@doriface/client";

test("an invite defaults to the first online machine by name, never an offline machine", () => {
  const connection = { hello: {} } as HcConnection;
  const entries: readonly MemberEntry[] = [
    {
      target: { hostId: "c", hostName: "Zulu", hostKey: "", directUrl: "" },
      state: { phase: "open", connection, path: "relay" },
    },
    { target: { hostId: "a", hostName: "Alpha", hostKey: "", directUrl: "" }, state: { phase: "unconfigured" } },
    {
      target: { hostId: "b", hostName: "Beta", hostKey: "", directUrl: "" },
      state: { phase: "open", connection, path: "relay" },
    },
  ];
  const choices = onlineInviters(entries);
  expect(choices.map((entry) => entry.target.hostId)).toEqual(["b", "c"]);
  const html = renderToStaticMarkup(<InviteMachineChoice entries={choices} selected="b" onSelect={() => {}} />);
  expect(html).toContain("The invite is opened on Beta");
  expect(html).toContain("Zulu");
  expect(html).not.toContain("Alpha");
});
