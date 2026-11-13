import { Spinner, StatusBarItem } from "@doriface/ui";
import { Cable, Globe, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { DirectReason } from "../connection/direct-attempt.ts";
import { canForwardPlainWs } from "../connection/direct-forward.ts";
import { staysOnThisComputer } from "../connection/settings.ts";
import { connectionStore, useConnection } from "../connection/store.ts";
import { useOnline } from "../pwa/use-online.ts";
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
  if (state.phase === "open" && state.resuming === true)
    return { label: "Reconnecting…", detail: "Reconnecting: the session carries on where it was.", offline: false };
  if (state.phase === "open" || state.phase === "unconfigured" || state.phase === "host-failed" || state.stale === null)
    return null;
  const label = seconds === null ? "Reconnecting…" : `Reconnecting in ${seconds} s`;
  return { label, detail: failed === null ? label : `${label}: ${failed.error.message}`, offline: false };
}

const glyph = (notice: ConnectionNotice, box: "size-3.5" | "h-[1lh] w-4") => (
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
 * until dismissed; noted as the line went down, it takes the notice's place in the same render, at its height.
 */
export function ConnectionLine({ address }: { readonly address?: string }) {
  const notice = useConnectionNotice();
  if (notice === null) return address === undefined ? null : <HistoryGapLine address={address} />;
  return (
    <div className={PHONE_LINE}>
      <p
        role="status"
        className={`${PHONE_LINE_TEXT} [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground`}
      >
        {/* A box as tall as one line (#1961), so the glyph centres on the first line as the words do. */}
        {glyph(notice, "h-[1lh] w-4")}
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
