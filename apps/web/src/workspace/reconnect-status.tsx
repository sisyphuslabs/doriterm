import type { HcConnection } from "@doriface/client";
import { Spinner, StatusBarItem } from "@doriface/ui";
import { Cable, Globe, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { DirectReason } from "../connection/direct-attempt.ts";
import { canForwardPlainWs } from "../connection/direct-forward.ts";
import { hostFailure } from "../connection/host-failure.ts";
import { staysOnThisComputer } from "../connection/settings.ts";
import { connectionStore, useConnection } from "../connection/store.ts";
import { useOnline } from "../pwa/use-online.ts";
import { useMachineLine } from "../terminal/use-machine-line.ts";
import { HistoryGapLine } from "./history-gap-status.tsx";
import { PHONE_LINE, PHONE_LINE_TEXT } from "./phone-line.ts";
import { RetryButton } from "./retry-button.tsx";

function useSecondsUntil(at: number | null, longest: number): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(1, Math.min(longest, Math.ceil((at - now) / 1000)));
}

export interface ConnectionNotice {
  /** The short words: a status bar item. */
  readonly label: string;
  /** The whole sentence: a tooltip, or the phone terminal's notice line. */
  readonly detail: string;
  /** Offline waits on the network, not on a timer: a still glyph, not a spinner. */
  readonly offline: boolean;
}

/** What to say about the workspace's connection while it is not usable, or null while it is. */
export function useConnectionNotice(): ConnectionNotice | null {
  const state = useConnection();
  const online = useOnline();
  const failed = state.phase === "failed" ? state : null;
  const seconds = useSecondsUntil(failed?.retryAt ?? null, Math.ceil((failed?.retryInMs ?? 0) / 1000));
  if (!online && !staysOnThisComputer(connectionStore.settings))
    return { label: "Offline", detail: "Offline. Reconnects when the network is back.", offline: true };
  // The session's socket dropped and the session is carried on over a new one: the workspace stays as it is meanwhile.
  // A dial that failed meanwhile says why and what to do, in the words Settings uses (#2426), never a socket's message.
  if (state.phase === "open" && state.resuming === true) {
    const why = state.resumeFailure === undefined ? "the session carries on where it was." : hostFailure(state.resumeFailure);
    return { label: "Reconnecting…", detail: `Reconnecting: ${why}`, offline: false };
  }
  if (state.phase === "open" || state.phase === "unconfigured" || state.phase === "host-failed" || state.stale === null)
    return null;
  const label = seconds === null ? "Reconnecting…" : `Reconnecting in ${seconds} s`;
  if (failed === null) return { label, detail: label, offline: false };
  const why = failed.settling === true ? failed.error.message : hostFailure(failed.error);
  return { label, detail: `${label}. ${why}`, offline: false };
}

/**
 * The added machine the terminal in view runs on, while its line is down: keys typed meanwhile wait for it (HeldInput,
 * #1489). Said beside the terminal, in the status bar or the phone's line, never drawn over its output (#2464).
 */
const machineNotice = (machine: string): ConnectionNotice => {
  const sentence = `Reconnecting to ${machine}. Your typing will be sent.`;
  return { label: sentence, detail: sentence, offline: false };
};

const glyph = (notice: ConnectionNotice, box: "size-3.5" | "size-4") => (
  <span className={`flex shrink-0 items-center justify-center ${box}`}>
    {notice.offline ? <WifiOff aria-hidden /> : <Spinner />}
  </span>
);

/** Status bar item while the workspace on screen is offline or waits for its connection; typing meanwhile is kept. */
/** `compact`: the label only, for a phone, whose screen says the whole notice in a ConnectionLine instead. */
export function ReconnectStatus({ compact = false }: { readonly compact?: boolean }) {
  const notice = useConnectionNotice();
  if (notice === null) return null;
  if (compact) {
    return (
      <span role="status" className="flex min-w-0" title={notice.detail}>
        <StatusBarItem icon={glyph(notice, "size-3.5")}>
          <span className="text-foreground">{notice.label}</span>
        </StatusBarItem>
      </span>
    );
  }
  // Offline, what happens next is said in the bar itself (a phone shows no tooltip), with a way to try at once (#475).
  return (
    <span
      role="status"
      className={notice.offline ? "flex shrink-0 items-center gap-2" : "flex min-w-0"}
      title={notice.detail}
    >
      <StatusBarItem icon={glyph(notice, "size-3.5")}>
        <span className="text-foreground">{notice.offline ? notice.detail : notice.label}</span>
      </StatusBarItem>
      {notice.offline ? <RetryButton size="sm" onRetry={() => Promise.resolve(connectionStore.retryNow())} /> : null}
    </span>
  );
}

/** The status bar item while the focused terminal's machine line is down; nothing while it is up or no terminal is focused. */
export function MachineLineStatus({
  connection,
  address,
}: {
  readonly connection: HcConnection;
  readonly address: string | null;
}) {
  const away = useMachineLine(connection, address ?? "", address !== null);
  if (away === null) return null;
  const notice = machineNotice(away);
  return (
    <span role="status" className="flex min-w-0" title={notice.detail}>
      <StatusBarItem icon={glyph(notice, "size-3.5")}>
        <span className="text-foreground">{notice.label}</span>
      </StatusBarItem>
    </span>
  );
}

/** Connected is the open session's baseline only while no notice (Reconnecting, Offline) applies. */
export const showsConnected = (phase: string, notice: ConnectionNotice | null): boolean =>
  phase === "open" && notice === null;

/**
 * The bar's quiet baseline while the session is open and nothing is wrong (#1456): a change to Reconnecting or Offline
 * then reads against it. Exactly one connection item shows at a time, since this one gives way to ReconnectStatus.
 */
export function ConnectedStatus() {
  const state = useConnection();
  const notice = useConnectionNotice();
  if (!showsConnected(state.phase, notice)) return null;
  return (
    <span data-connected className="flex shrink-0">
      <StatusBarItem icon={<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-online" />}>
        Connected
      </StatusBarItem>
    </span>
  );
}

const DIRECT_REASONS: Record<DirectReason, string> = {
  blocked: "this page can't open ws:// to another machine; use wss://",
  "unusable-address": "the saved address can't be used",
  "no-answer": "no answer within 300 ms",
  "could-not-connect": "could not connect",
  "authentication-failed": "the host key did not match",
};

/**
 * The transport the open session runs on. A browser reaches every member over the relay (#1381 §8), so its label says
 * Relay on every session; the Direct label and its reasons (#446) are the desktop shell's, whose paired host still races
 * direct and whose forwarder is the only thing that may dial one. A phone shows it in its own bar, whose screen has no
 * tooltip.
 */
export function ConnectionPathItem() {
  const state = useConnection();
  if (state.phase !== "open" || connectionStore.settings.mode !== "relay") return null;
  if (!canForwardPlainWs()) {
    return (
      <span
        data-connection-path="relay"
        className="flex shrink-0"
        title="Relay: every session from a browser goes through the relay."
      >
        <StatusBarItem icon={<Globe aria-hidden />}>Relay</StatusBarItem>
      </span>
    );
  }
  if (connectionStore.settings.directUrl.trim() === "") return null;
  const direct = state.path === "direct";
  const reason = state.directReason;
  const detail = direct
    ? "Direct: this device reached your host on your network."
    : `Relay: ${reason === undefined ? "the relay carried this session." : DIRECT_REASONS[reason]}.`;
  return (
    <span data-connection-path={state.path} className="flex shrink-0" title={detail}>
      <StatusBarItem icon={direct ? <Cable aria-hidden /> : <Globe aria-hidden />}>
        {direct ? "Direct" : "Relay"}
      </StatusBarItem>
    </span>
  );
}

/**
 * The phone has no status bar: the same notice as one line under a screen's header, only while there is one. On a
 * terminal's screen (`address`), once connected, the line says when that terminal may have lost output (#2033, #2257),
 * until dismissed; noted as the line went down, it takes the notice's place in the same render, at its height. While
 * that terminal's machine line is down (`connection` given), the line says it reconnects to that machine instead.
 */
export function ConnectionLine({
  address,
  connection,
}: {
  readonly address?: string;
  readonly connection?: HcConnection;
}) {
  const notice = useConnectionNotice();
  if (notice !== null) return <NoticeLine notice={notice} />;
  if (address === undefined) return null;
  if (connection === undefined) return <HistoryGapLine address={address} />;
  return <TerminalLine connection={connection} address={address} />;
}

function TerminalLine({ connection, address }: { readonly connection: HcConnection; readonly address: string }) {
  const away = useMachineLine(connection, address, true);
  return away === null ? <HistoryGapLine address={address} /> : <NoticeLine notice={machineNotice(away)} />;
}

function NoticeLine({ notice }: { readonly notice: ConnectionNotice }) {
  return (
    <div className={PHONE_LINE}>
      <p
        role="status"
        className={`${PHONE_LINE_TEXT} [&_svg:not([data-slot=spinner])]:mt-0.5 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground`}
      >
        {glyph(notice, "size-4")}
        {/* The sentence is required content (DESIGN.md 5 (e)): it wraps at narrow widths rather than losing its end. */}
        <span className="min-w-0 text-pretty break-words" title={notice.detail}>
          {notice.offline ? notice.detail : notice.label}
        </span>
      </p>
      {notice.offline ? (
        <RetryButton size="sm" className="-my-1 shrink-0" onRetry={() => Promise.resolve(connectionStore.retryNow())} />
      ) : null}
    </div>
  );
}
