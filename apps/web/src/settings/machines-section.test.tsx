import { expect, test } from "bun:test";
import type { MachineView } from "@doriface/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineNotice } from "../workspace/machine-notice.tsx";
import { MachineOffline } from "../workspace/machine-offline.tsx";
import { MachinesContext, useMachinesContext } from "../workspace/use-machines.ts";
import { AddedMachine } from "./machines-section.tsx";

/** An added machine as hc's machine.list reports it (hc-api.ts MachineView). */
const listed = (version: string): MachineView => ({
  host: "box.local",
  id: "core-box",
  name: "box",
  state: "connected",
  target: "doriface-host connect h-box",
  via: true,
  version,
});

const row = (view: MachineView): string =>
  renderToStaticMarkup(
    <AddedMachine
      view={view}
      now={1_800_000_000_000}
      onRetry={async () => undefined}
      onRemove={async () => undefined}
    />,
  );

/** The same machine reached as a mesh member: its line is the pinned via form a mesh reconciler adds (groups.ts). */
const member = (view: MachineView): MachineView => ({
  ...view,
  target: `'/opt/doriface/bin/doriface-host' connect --mesh --state-dir '/var/lib/doriface' ${"a".repeat(25)}q`,
});

test("an added machine's row says to update hc there when machine.list reports its core below the floor (#2285)", () => {
  const html = row(listed("0.1.16"));
  expect(html).toContain("box&#x27;s herdr-core is 0.1.16, and Doriterm needs");
  expect(html).toContain("Run hc update on that computer.");
  // A core at the floor reads as the connected machine it is, with nothing to do.
  expect(row(listed("0.1.20"))).not.toContain("Run hc update");
});

/** The sidebar's notice under a machine's header, with the machine list the workspace would provide. */
function Notice({ view }: { readonly view: MachineView }) {
  const machines = { ...useMachinesContext(), views: [view] };
  return (
    <MachinesContext value={machines}>
      <MachineNotice name={view.name} />
    </MachinesContext>
  );
}

test("the sidebar notice for an old core says to update hc there and offers no Try again, which cannot help (#2285)", () => {
  const old = renderToStaticMarkup(<Notice view={listed("0.1.16")} />);
  expect(old).toContain("Run hc update on that computer.");
  expect(old).not.toContain("Try again");
  // A machine whose line is down still gets its Try again.
  const down = renderToStaticMarkup(<Notice view={{ ...listed("0.1.20"), state: "unreachable", why: "(4404)" }} />);
  expect(down).toContain("Try again");
});

test("the sidebar raises no notice and no Try again while a machine is inside its reconnect grace (#1686, #2464)", () => {
  const held = renderToStaticMarkup(<Notice view={{ ...listed("0.1.20"), state: "reconnecting" }} />);
  expect(held).toBe("");
  // Past the grace it reads offline: then the notice says why, with its one Try again.
  const gone = renderToStaticMarkup(<Notice view={{ ...listed("0.1.20"), state: "unreachable", why: "(4404)" }} />);
  expect(gone).toContain("Try again");
});

test("a machine added by hand offers Remove in its row and beside Try again; a mesh member offers neither (#2456)", () => {
  const down: MachineView = { ...listed("0.1.20"), state: "unreachable", why: "(4404)" };
  expect(row(listed("0.1.20"))).toContain("Remove box\u2026");
  expect(renderToStaticMarkup(<Notice view={down} />)).toContain("Remove box\u2026");
  expect(row(member(down))).not.toContain("Remove box");
  expect(row(member(down))).toContain("Try again");
  expect(renderToStaticMarkup(<Notice view={member(down)} />)).not.toContain("Remove box");
});

/** The pane shown instead of a terminal on a machine that cannot be reached, with the machine list the workspace gives. */
function OfflinePane({ view }: { readonly view: MachineView }) {
  const machines = { ...useMachinesContext(), views: [view] };
  return (
    <MachinesContext value={machines}>
      <MachineOffline machine={view.name} />
    </MachinesContext>
  );
}

test("an offline pane offers Remove beside Try again for a machine added by hand, and only Try again for a mesh member (#2456)", () => {
  const down: MachineView = { ...listed("0.1.20"), state: "unreachable", why: "(4404)" };
  const pane = renderToStaticMarkup(<OfflinePane view={down} />);
  expect(pane).toContain("Try again");
  expect(pane).toContain('aria-label="Remove box\u2026"');
  const meshPane = renderToStaticMarkup(<OfflinePane view={member(down)} />);
  expect(meshPane).toContain("Try again");
  expect(meshPane).not.toContain("Remove box");
});
