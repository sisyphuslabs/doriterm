import type { CardBody } from "@doriface/mesh";
import { meshRevokeCommand, type MeshMemberStatus } from "@doriface/protocol";
import { SettingRow } from "@doriface/ui";
import { Command } from "../mesh/mesh-rows.tsx";
import { formatAge } from "../workspace/model.ts";
import { Subgroup } from "./settings-layout.tsx";

export function RevokeCommand({ name }: { readonly name: string }) {
  const command = meshRevokeCommand(name);
  return command === undefined ? null : <Command command={command} label={`Copy the command that removes ${name}`} />;
}

/** Session times belong to one reporting machine; signed membership supplies the names and identities. */
export function BrowserMemberList({
  clients,
  self,
  observer,
  observations,
  now,
}: {
  readonly clients: readonly Pick<CardBody, "hostId" | "name" | "signPub">[];
  readonly self: string | undefined;
  readonly observer: string | undefined;
  readonly observations: readonly Pick<MeshMemberStatus, "hostId" | "lastSessionAt">[] | undefined;
  readonly now: number;
}) {
  return (
    <Subgroup id="browser-members" title="Browsers and phones">
      {clients.map((client) => {
        const at = observations?.find((member) => member.hostId === client.hostId)?.lastSessionAt;
        const age = at === undefined ? undefined : formatAge(at, now);
        const time = age === undefined ? "not recorded" : age === "<1m" ? "just now" : `${age} ago`;
        const report =
          observer === undefined || observations === undefined
            ? "Last session: unavailable"
            : `Last session on ${observer}: ${time}`;
        return (
          <SettingRow
            key={client.signPub}
            title={`${client.name}${client.signPub === self ? " (this browser)" : ""}`}
            description={
              <>
                <span className="block">{report}</span>
                <RevokeCommand name={client.name} />
              </>
            }
            control={null}
          />
        );
      })}
    </Subgroup>
  );
}
