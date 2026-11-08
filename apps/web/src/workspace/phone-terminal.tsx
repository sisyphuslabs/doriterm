import type { HcConnection } from "@doriface/client";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApprovalOverlay } from "../approval/approval-overlay.tsx";
import { RegionBoundary } from "../crash/region-boundary.tsx";
import { useKeyBarSettings } from "../keybar/store.ts";
import { useMouseOnly, useSoftKeyboard } from "../terminal/keyboard-inset.ts";
import { useHostPlatform } from "../terminal/host-os.ts";
import { closesTab } from "../terminal/terminal-end.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { TerminalView } from "../terminal/terminal-view.tsx";
import { DictateButton } from "../voice/dictate-button.tsx";
import { useDictation } from "../voice/use-dictation.ts";
import { VoiceDock } from "../voice/voice-dock.tsx";
import { MachineOffline } from "./machine-offline.tsx";
import { machineOf, type Session, terminalTitle } from "./model.ts";
import { PackSheet } from "./pack-sheet.tsx";
import { PhoneHeader } from "./phone-header.tsx";
import { PaneSwitcher } from "./phone-pane-switcher.tsx";
import { PhoneTabSwitcher, useSpaceTabs } from "./phone-tab-switcher.tsx";
import {
  DIRECTION_PAD_CLEARANCE,
  KEYBOARD_BUTTON_CLEARANCE,
  KEYS_BAR_HEIGHT,
  keysBottom,
  PhoneKeys,
  roundButtonsClearance,
} from "./phone-keys.tsx";
import { ConnectionLine } from "./reconnect-status.tsx";
import { afterEnd } from "./session-actions.ts";
import { useStickyKeys } from "./use-sticky-keys.ts";

export interface PhoneTerminalProps {
  readonly connection: HcConnection;
  readonly terminal: Session;
  readonly terminals: readonly Session[];
  /** The terminals of the tab that shows this one, in its panes' order; one when that tab is not split. */
  readonly panes: readonly string[];
  /** Its tab's own name; null when the tab has none (or it is in no tab), so the terminal's title names it. */
  readonly tabTitle: string | null;
  /** The space its Back returns to, by name; null when Back goes to the agents list. */
  readonly backTo: string | null;
  readonly onOpen: (address: string) => void;
  readonly onBack: () => void;
  /** The Spaces sheet's tab controls: close the tab that shows an address, start a tab in a space (#1463). */
  readonly onCloseTab: (address: string) => void;
  readonly onNewInSpace: (space: string) => void;
  /** Where this terminal registers its dictation for the shell's palette row and bound key; null while it takes none. */
  readonly dictate: RefObject<(() => void) | null>;
  /**
   * This page asked for this terminal's pane (a session picked from the keys bar): its view takes the keyboard as it
   * opens. Unset, opening a terminal on a phone leaves the soft keyboard down (#1375).
   */
  readonly claimed: boolean;
  /** A session picked from the keys bar, which is the person asking for its keyboard as it opens. */
  readonly onPick: (address: string) => void;
  /** The keyboard a pick asked for is up: the ask is answered, so a later re-attach takes none of its own (#1375). */
  readonly onClaimed: () => void;
}

/** One session full screen on a phone, its terminal kept clear of the soft keyboard and the keys bar riding on it. */
export function PhoneTerminal(props: PhoneTerminalProps) {
  const {
    connection,
    terminal,
    terminals,
    panes,
    tabTitle,
    backTo,
    onOpen,
    onBack,
    onCloseTab,
    onNewInSpace,
    dictate,
  } = props;
  const { claimed, onPick, onClaimed } = props;
  const port = useRef<TerminalPort | null>(null);
  const onPort = useCallback((next: TerminalPort | null) => {
    port.current = next;
  }, []);
  const [scope, setScope] = useState<HTMLDivElement | null>(null);
  const keyboard = useSoftKeyboard(scope);
  // A mouse-only device has no soft keyboard to ride on: its keys bar is opened and closed by hand (#287).
  const mouseOnly = useMouseOnly();
  // The keyboard is down again — closed by its own key, by the keys' Hide, or by the focus moving away — so the field asks
  // for none until the keys ask again, and the next press in the terminal raises nothing (#1375). A press that lets the
  // field go and takes it back in the same gesture is no dismissal: this waits a frame for the focus to come back.
  useEffect(() => {
    if (claimed && keyboard.up) onClaimed();
  }, [claimed, keyboard.up]);
  useEffect(() => {
    if (keyboard.up) return undefined;
    const frame = requestAnimationFrame(() => port.current?.quiet());
    return () => cancelAnimationFrame(frame);
  }, [keyboard.up]);
  const [keysShown, setKeysShown] = useState(false);
  // Read-only browsing (browse-mode.ts) belongs to the terminal it was turned on for: opening another ends it.
  const [browsingOn, setBrowsingOn] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [pad, setPad] = useState(false);
  // The keys bar as drawn, which grows while its field has a row of its own; the terminal keeps clear of all of it.
  const [barHeight, setBarHeight] = useState(0);
  const [packs, setPacks] = useState(false);
  const keyBar = useKeyBarSettings();
  // A rename moves the address, a restarted program changes the pid: either way the view attaches afresh.
  const viewKey = `${terminal.address}#${terminal.pid ?? ""}`;
  // The view that showed its program had already ended; the keys have nothing to send to under it.
  const [endedView, setEndedView] = useState<string | null>(null);
  const ended = endedView === viewKey;
  const title = terminalTitle(terminal);
  const machine = machineOf(terminal.address);
  const offline = terminal.offline === true && machine !== undefined;
  const browsing = browsingOn === terminal.address && !ended && !offline;
  const setBrowsing = (on: boolean): void => setBrowsingOn(on ? terminal.address : null);
  const host = useHostPlatform(connection, machine, offline);
  const sticky = useStickyKeys(port, host);
  const voice = useDictation();
  const mic = useRef<HTMLButtonElement>(null);
  const { toggle } = voice;
  // An ended view, an offline machine or a terminal browsed read-only has nothing to type into: no mic, no dictation
  // from the palette, and one under way ends.
  const untyped = offline || ended || browsing;
  useEffect(() => {
    dictate.current = untyped ? null : toggle;
    return () => {
      dictate.current = null;
    };
  }, [dictate, untyped, toggle]);
  useEffect(() => {
    if (untyped) voice.dictation.close();
  }, [untyped, voice.dictation]);
  const dictating = voice.state.kind !== "idle" && !untyped;
  // The packs panel takes the screen for a moment, so the bar stays under it as it does under the session menu: closing
  // the panel puts the person back on the terminal's keyboard.
  const keysOpen = !ended && !dictating && !browsing && (keyboard.up || menu || packs || (mouseOnly && keysShown));
  // The tabs bar takes the bottom while nothing rides there: the keys bar, with the soft keyboard, and dictation do.
  const tabs = useSpaceTabs(terminals, terminal.address);
  const tabsBar = !keysOpen && !dictating && tabs.some((tab) => tab.includes(terminal.address));
  // The terminal's jump button stays clear of what floats over its bottom right: the keyboard button, or the arrow pad.
  // Over the tabs bar the keyboard button floats beside the bar, not over the terminal.
  const keysControls =
    offline || ended || dictating
      ? null
      : !keysOpen
        ? tabsBar
          ? null
          : KEYBOARD_BUTTON_CLEARANCE
        : pad
          ? DIRECTION_PAD_CLEARANCE
          : null;

  return (
    // isolate: the keys float above the terminal (z-10) but stay under a dialog and its backdrop, which portal to the body.
    <div
      ref={setScope}
      className="relative isolate flex h-dvh min-h-0 flex-col bg-card pr-(--safe-right) pl-(--safe-left)"
    >
      <PhoneHeader
        terminal={terminal}
        host={connection.hello.core.name}
        tabTitle={tabTitle}
        backTo={backTo}
        onBack={onBack}
        action={untyped ? null : <DictateButton voice={voice} target={title} ref={mic} />}
      />
      <ConnectionLine />
      <PaneSwitcher panes={panes} open={terminal.address} onOpen={onOpen} />
      {/* The page's one main landmark: the terminal, under its header (#1378). */}
      <main
        className="relative flex min-h-0 flex-1 flex-col"
        style={
          keysOpen
            ? {
                paddingBottom: `calc(${keysBottom(keyboard.inset)} + ${barHeight > 0 ? `${barHeight}px` : KEYS_BAR_HEIGHT})`,
              }
            : undefined
        }
      >
        <RegionBoundary
          region={`pane:${terminal.address}`}
          title="This terminal could not be drawn"
          detail="The program keeps running on the host."
        >
          {offline ? null : <ApprovalOverlay connection={connection} terminal={terminal} />}
          {offline ? (
            <MachineOffline machine={machine} />
          ) : (
            <TerminalView
              key={viewKey}
              connection={connection}
              address={terminal.address}
              pid={terminal.pid ?? null}
              live={terminal.state === "live"}
              focused
              claimed={claimed}
              // A soft keyboard is the phone's to ask for, so opening a terminal leaves it down (#1375); a narrow window
              // driven by a mouse has none to raise, and keeps taking the focus as it starts (#287).
              softKeyboard={!mouseOnly}
              label={`${title} output`}
              transformInput={sticky.transform}
              typesComposition={sticky.latched.size > 0}
              browsing={browsing}
              onPort={onPort}
              // An End of this session leaves the screen only once it has removed the terminal (see afterEnd).
              onEnd={(address, end) => (closesTab(end) ? afterEnd(address, onBack) : undefined)}
              // The header already has Back; this one closes the ended session.
              closeLabel="Close"
              {...(keysControls === null ? {} : { jumpClearance: keysControls })}
              onEnded={() => setEndedView(viewKey)}
            />
          )}
        </RegionBoundary>
        {browsing ? (
          <p
            role="status"
            className="pointer-events-none absolute top-2 right-4 z-10 rounded-full border border-border bg-chrome/90 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur-md"
          >
            Read-only
          </p>
        ) : null}
      </main>
      {tabsBar ? (
        <PhoneTabSwitcher
          terminals={terminals}
          tabs={tabs}
          active={terminal.address}
          title={tabTitle ?? title}
          onOpen={onOpen}
          // A touch device's Read-only button takes the slot left of the keyboard button's; a mouse-only one has none.
          clearance={roundButtonsClearance(mouseOnly ? 1 : 2)}
          onCloseTab={onCloseTab}
          onNewInSpace={onNewInSpace}
        />
      ) : null}
      {dictating ? (
        // Dictation takes the keys' place, riding on the soft keyboard when it is up; the transcript is typed past the
        // sticky modifiers, as written.
        <VoiceDock
          voice={voice}
          target={title}
          onType={(text) => {
            port.current?.send(text);
            port.current?.focus();
          }}
          onClose={() => mic.current?.focus()}
          className="pb-[max(0.5rem,var(--safe-bottom))]"
          {...(keyboard.inset > 0 ? { style: { marginBottom: `${keyboard.inset}px` } } : {})}
        />
      ) : offline || ended ? null : (
        <>
          <PhoneKeys
            port={port}
            open={keysOpen}
            inset={keyboard.inset}
            host={host}
            sticky={sticky}
            terminals={terminals}
            current={terminal.address}
            onOpen={onPick}
            onMenu={setMenu}
            pad={pad}
            onPad={setPad}
            onBarHeight={setBarHeight}
            onPacks={() => setPacks(true)}
            browsing={browsing}
            {...(mouseOnly ? { onKeys: setKeysShown } : { onBrowse: setBrowsing })}
          />
        </>
      )}
      {offline || ended ? null : (
        <PackSheet
          open={packs}
          onOpenChange={(open) => {
            setPacks(open);
            if (!open) requestAnimationFrame(() => port.current?.focus());
          }}
          settings={keyBar}
        />
      )}
    </div>
  );
}
