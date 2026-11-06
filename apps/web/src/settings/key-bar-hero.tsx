import { ExtraKeysBar } from "@doriface/ui";
import { useState } from "react";
import { activeEntries, packName, specialEntries } from "../keybar/entries.ts";
import { toExtra } from "../keybar/render.tsx";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { MODIFIERS, type HostPlatform } from "../terminal/keys.ts";

export interface KeyBarHeroProps {
  readonly settings: KeyBarSettings;
  readonly host: HostPlatform;
}

const toggle = (latched: readonly string[], id: string): readonly string[] =>
  latched.includes(id) ? latched.filter((entry) => entry !== id) : [...latched, id];

/**
 * The bar itself, drawn by the component the terminal draws and in the same pill, so what the page shows is what the
 * phone will show. Its modifiers latch on a tap to show what latching looks like; nothing here can send anything.
 */
export function KeyBarHero({ settings, host }: KeyBarHeroProps) {
  const [latched, setLatched] = useState<readonly string[]>([]);
  const keys = specialEntries(settings, host).map(toExtra);
  const packKeys = activeEntries(settings).map(toExtra);
  const pack = settings.activePack === null ? null : packName(settings.activePack);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-key-bar-hero>
      <div className="flex items-center justify-between px-3 pt-3">
        <p className="font-mono text-[0.6875rem] text-muted-foreground">$ doriterm</p>
        {pack === null ? null : <p className="text-[0.6875rem] text-muted-foreground">{pack}</p>}
      </div>
      <div className="px-1 pt-2 pb-1">
        <ExtraKeysBar
          keys={keys}
          packKeys={packKeys}
          latched={latched}
          onKey={(id) => {
            if (MODIFIERS.has(id)) setLatched((current) => toggle(current, id));
          }}
          inputField={
            <span className="mx-1 flex h-9 w-[6.5rem] items-center rounded-full border border-input px-3 text-xs text-muted-foreground">
              Type
            </span>
          }
        />
      </div>
      <p className="px-3 pb-2 text-[0.6875rem] text-muted-foreground">
        {latched.length === 0 ? "This is the bar in every terminal." : "Latched for the next key."}
      </p>
    </div>
  );
}
