import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  inviteChoices,
  inviteMachine,
  onlineInviters,
  openingMachine,
  InviteMachineChoice,
} from "./browser-invite.tsx";
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

const machine = (hostId: string, hostName: string, state: MemberEntry["state"]): MemberEntry => ({
  target: { hostId, hostName, hostKey: "", directUrl: "" },
  state,
});
const live = (resuming: boolean): MemberEntry["state"] => ({
  phase: "open",
  connection: { hello: {} } as HcConnection,
  path: "relay",
  resuming,
});
const offline: MemberEntry["state"] = {
  phase: "failed",
  error: new Error("offline"),
  retryInMs: 1_000,
  retryAt: 0,
  stale: null,
};
const idsOf = (entries: readonly MemberEntry[]) => entries.map((entry) => entry.target.hostId);
const both = (beta: MemberEntry["state"], zulu: MemberEntry["state"]) => [
  machine("b", "Beta", beta),
  machine("c", "Zulu", zulu),
];

test("a machine whose session is being carried on is not offered for an invite (#2429)", () => {
  const entries = [machine("b", "Beta", live(true)), machine("c", "Zulu", live(false))];
  expect(idsOf(onlineInviters(entries))).toEqual(["c"]);
  expect(inviteMachine(entries, undefined)?.target.hostId).toBe("c");
  expect(onlineInviters([machine("b", "Beta", live(true))])).toEqual([]);
});

test("an open invite keeps its machine through a resume, its own or another machine's (#2429)", () => {
  expect(inviteMachine(both(live(true), live(false)), "b")?.target.hostId).toBe("b");
  expect(inviteMachine(both(live(false), live(true)), "b")?.target.hostId).toBe("b");
  expect(inviteMachine(both(live(true), live(false)), "c")?.target.hostId).toBe("c");
});

test("an open invite falls back to the first machine offered once its own is offline (#2429)", () => {
  const entries = [machine("b", "Beta", offline), machine("c", "Zulu", live(false))];
  expect(inviteMachine(entries, "b")?.target.hostId).toBe("c");
  expect(inviteMachine([machine("b", "Beta", offline)], "b")).toBeUndefined();
});

test("the choice lists the machines offered and the dialog's own machine while it resumes (#2429)", () => {
  const entries = [
    machine("a", "Alpha", live(true)),
    machine("b", "Beta", live(true)),
    machine("c", "Zulu", live(false)),
  ];
  expect(idsOf(inviteChoices(entries, "b"))).toEqual(["b", "c"]);
  expect(idsOf(inviteChoices(entries, "c"))).toEqual(["c"]);
  expect(idsOf(inviteChoices(entries, undefined))).toEqual(["c"]);
});

test("a dialog opens on a machine offered now: the last one chosen, unless it is resuming (#2429)", () => {
  expect(openingMachine(both(live(false), live(false)), "c")).toBe("c");
  expect(openingMachine(both(live(false), live(false)), undefined)).toBe("b");
  expect(openingMachine(both(live(true), live(false)), "b")).toBe("c");
  expect(openingMachine([machine("b", "Beta", live(true))], "b")).toBeUndefined();
});
