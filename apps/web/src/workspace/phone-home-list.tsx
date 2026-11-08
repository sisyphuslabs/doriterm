import type { Terminal } from "@doriface/protocol";
import { AgentsGroup } from "./agents-group.tsx";
import type { PhoneHomeTab } from "./phone-home-tab.ts";
import { SpacesGroup } from "./spaces-group.tsx";

/**
 * One tab's list on the phone home. Keyed by tab, so a switch inserts a fresh region that arrives over Micro (DESIGN.md
 * section 6, `.motion-arrive`) with a 4 px rise; reduced motion keeps only the fade. The screen title already names the
 * Spaces list, so its own section heading stays for screen readers only.
 */
export function PhoneHomeList({
  tab,
  terminals,
  onOpen,
}: {
  readonly tab: PhoneHomeTab;
  readonly terminals: readonly Terminal[];
  readonly onOpen: (address: string) => void;
}) {
  return (
    <div
      key={tab}
      data-phone-home={tab}
      className="motion-arrive flex flex-col gap-4 px-2 pb-3 [--arrive-duration:var(--duration-micro)] [--arrive-from:translateY(4px)] data-[phone-home=spaces]:[&>section>header]:sr-only"
    >
      {tab === "agents" ? (
        <AgentsGroup terminals={terminals} active={null} onOpen={onOpen} heading={false} />
      ) : (
        <SpacesGroup onOpen={onOpen} />
      )}
    </div>
  );
}
