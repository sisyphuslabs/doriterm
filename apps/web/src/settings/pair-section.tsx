import { SettingRow } from "@doriface/ui";
import { Command } from "../mesh/mesh-rows.tsx";
import { PairDeviceOffer } from "./pair-device-offer.tsx";

/**
 * How another computer or a phone joins this one. Both directions are commands on the host, so this screen names them
 * and says where the join waits; the host's own view of a pending join is approved under Machines. On the desktop
 * app the same screen also offers this computer without a command line, since that is the answer a reader who opened it
 * is looking for (review of #772).
 */
export function PairSection() {
  return (
    <div className="flex flex-col">
      <PairDeviceOffer />
      <SettingRow
        title="Open an invite on your host"
        description={
          <>
            Prints a link, and a QR code to scan, that one other computer or phone can join with. It ends after ten
            minutes, or once it is used.
            <Command command="doriface-host mesh pair" label="Copy the command that opens an invite" />
          </>
        }
        control={null}
      />
      <SettingRow
        title="Join from the other computer"
        description={
          <>
            Run this there with the link or the code the invite printed.
            <Command command="doriface-host mesh join <link or code>" label="Copy the command that joins a mesh" />
          </>
        }
        control={null}
      />
      <SettingRow
        title="A phone that uses one host only"
        description={
          <>
            A phone without a mesh pairs with a single host: the command prints the link the app opens on the phone.
            <Command command="doriface-host pair" label="Copy the command that pairs a phone with one host" />
          </>
        }
        control={null}
      />
    </div>
  );
}
