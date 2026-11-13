import { expect, test } from "bun:test";
import type { MachineView } from "@doriface/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineNotice } from "../workspace/spaces-group.tsx";
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
  renderToStaticMarkup(<AddedMachine view={view} now={1_800_000_000_000} onRetry={async () => undefined} />);

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
