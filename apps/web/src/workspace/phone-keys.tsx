import { DirectionPad, ExtraKeysBar, extraKeys, KeyboardButton, Menu, MenuItem } from "@doriface/ui";
import { type RefObject, useState } from "react";
import type { HostPlatform } from "../terminal/keys.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { machineOf, type Session, terminalTitle } from "./model.ts";
import type { StickyKeys } from "./use-sticky-keys.ts";

export function keysBottom(inset: number): string {
  return inset > 0 ? `${inset}px` : "var(--safe-bottom)";
}

/** The keys bar's own height (a 3.25rem pill and 0.25rem above and below it), which the terminal keeps clear. */
export const KEYS_BAR_HEIGHT = "3.75rem";

export interface PhoneKeysProps {
  readonly port: RefObject<TerminalPort | null>;
  readonly open: boolean;
  readonly inset: number;
  readonly host: HostPlatform;
  readonly sticky: StickyKeys;
  readonly terminals: readonly Session[];
  readonly current: string;
  readonly onOpen: (address: string) => void;
  readonly onMenu: (open: boolean) => void;
}

function hideKeyboard(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * The phone terminal's keys (after t3code's terminal screen): with the soft keyboard up, the keys bar rides on it and
 * can open the arrow pad; with it down, only a round keyboard button stays, at the bottom right.
 */
export function PhoneKeys(props: PhoneKeysProps) {
  const { port, open, inset, host, sticky, terminals, current, onOpen, onMenu } = props;
  const [pad, setPad] = useState(false);
  if (!open) {
    return (
      <KeyboardButton
        onPress={() => port.current?.focus()}
        className="absolute right-4 bottom-[max(1rem,calc(var(--safe-bottom)+0.5rem))] z-10"
      />
    );
  }
  const bottom = keysBottom(inset);
  return (
    <>
      {pad ? (
        <DirectionPad
          onKey={sticky.press}
          className="absolute right-3 z-10"
          style={{ bottom: `calc(${bottom} + ${KEYS_BAR_HEIGHT} + 0.5rem)` }}
        />
      ) : null}
      <ExtraKeysBar
        className="absolute inset-x-0 z-10"
        style={{ bottom }}
        keys={extraKeys(host === "mac")}
        latched={[...sticky.latched]}
        onKey={sticky.press}
        padOpen={pad}
        onPad={() => setPad((shown) => !shown)}
        onPaste={sticky.paste}
        onHideKeyboard={hideKeyboard}
        renderSessions={(trigger) => (
          <Menu
            trigger={trigger}
            align="end"
            onOpenChange={(shown) => {
              onMenu(shown);
              // Closing the menu puts focus back on its trigger; the terminal takes it after, so the keyboard stays.
              if (!shown) requestAnimationFrame(() => port.current?.focus());
            }}
          >
            {terminals.map((entry) => (
              <MenuItem
                key={entry.address}
                aria-current={entry.address === current ? "true" : undefined}
                onClick={() => onOpen(entry.address)}
              >
                {terminalTitle(entry)}
                {machineOf(entry.address) === undefined ? null : (
                  <span className="ml-2 text-xs text-muted-foreground">{machineOf(entry.address)}</span>
                )}
              </MenuItem>
            ))}
          </Menu>
        )}
      />
    </>
  );
}
