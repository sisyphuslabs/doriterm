import type { CardBody } from "@doriface/mesh";
import { meshRevokeCommand, type MeshMemberStatus } from "@doriface/protocol";
import { SettingRow } from "@doriface/ui";
import { Command } from "../mesh/mesh-rows.tsx";
import { formatAge } from "../workspace/model.ts";

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
    <section aria-labelledby="browser-members">
      <h3 id="browser-members" className="text-lg font-semibold">
        Browsers and phones
      </h3>
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
    </section>
  );
}
