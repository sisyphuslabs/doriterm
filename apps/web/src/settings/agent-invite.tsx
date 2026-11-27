import { Button, CopyBlock, Notice, cn } from "@doriface/ui";
import { useCallback, useEffect, useState } from "react";
import type { DesktopPairAnswer } from "../desktop/pair-bridge.ts";
import { useNow } from "../workspace/use-now.ts";
import { AGENTS, agentPrompt, agentSnippet, connectCommand, mcpConfig } from "./agent-snippets.ts";
import { expiryLine, offerCode, pairDeviceView, slotNote, type PairDeviceView } from "./pair-device.ts";
import { listRowClass } from "./settings-layout.tsx";

/** How often the invite asks the host what stands while an offer is live. */
const POLL_MS = 1_000;

export interface PairOfferState {
  readonly view: PairDeviceView;
  readonly hostId: string | null;
  readonly now: number;
  readonly again: () => void;
}

/** Opens and polls this computer's pairing offer while `open` is true, remembering the host id once seen. */
export function usePairOffer(
  pair: (request: "open" | "state") => Promise<DesktopPairAnswer>,
  open: boolean,
): PairOfferState {
  const [answer, setAnswer] = useState<DesktopPairAnswer | null>(null);
  // The offer names this host; the config needs that id after the offer itself is gone.
  const [hostId, setHostId] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const now = useNow(POLL_MS);
  const view = pairDeviceView(open ? answer : null, now);

  useEffect(() => {
    if (!open) {
      setAnswer(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (request: "open" | "state"): Promise<void> => {
      if (cancelled) return;
      try {
        const next = await pair(request);
        if (cancelled) return;
        setAnswer(next);
        if (next.state === "pending") {
          setHostId(next.offer.hostId);
          if (Date.now() < next.offer.expiresAt) timer = setTimeout(() => void poll("state"), POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setAnswer({ state: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      }
    };
    void poll("open");
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, pair, round]);

  const again = useCallback((): void => {
    setAnswer(null);
    setRound((value) => value + 1);
  }, []);

  return { view, hostId, now, again };
}

export interface AgentInviteProps {
  readonly pair: (request: "open" | "state") => Promise<DesktopPairAnswer>;
  /** Set false when mounted inside a closed dialog so no offer opens until shown. */
  readonly open?: boolean;
  /** Shared offer state when a parent dialog owns the header and retry action. */
  readonly offer?: PairOfferState;
  /** Show an inline retry button when expired or unavailable; defaults to true when standalone. */
  readonly inlineRetry?: boolean;
}

function AgentInviteBody({ offer, inlineRetry }: { readonly offer: PairOfferState; readonly inlineRetry: boolean }) {
  const { view, hostId, now, again } = offer;
  const [copied, setCopied] = useState<{ readonly key: string; readonly text: string } | null>(null);

  const isCopied = (key: string, text: string): boolean => copied?.key === key && copied.text === text;
  const copy = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ key, text });
    } catch {
      setCopied(null);
    }
  };

  if (view.kind === "asking") {
    return <p className="text-prose text-muted-foreground">Asking this computer's host for an invite…</p>;
  }

  if (view.kind === "offer") {
    const omoPrompt = agentPrompt(view.offer.link, view.offer.hostId, "omo");
    const promptText = agentPrompt(view.offer.link, view.offer.hostId);
    const note = slotNote(view.offer);
    const pairing = connectCommand(view.offer.link);
    return (
      <div className="flex flex-col gap-4">
        <section aria-labelledby="agent-omo" className="flex flex-col gap-1.5">
          <h3 id="agent-omo" className="text-base font-semibold text-foreground">
            OmO
          </h3>
          <p className="text-prose text-pretty text-muted-foreground">
            Paste this into OmO. It pairs this computer and adds Doriterm to OmO's MCP settings.
          </p>
          <CopyBlock
            label="OmO prompt"
            copyLabel="Copy prompt"
            text={omoPrompt}
            copied={isCopied("omo", omoPrompt)}
            onCopy={() => void copy("omo", omoPrompt)}
          />
        </section>
        <section aria-labelledby="agent-any" className="flex flex-col gap-1.5">
          <h3 id="agent-any" className="text-base font-semibold text-foreground">
            Any other agent
          </h3>
          <p className="text-prose text-pretty text-muted-foreground">
            Copy this prompt into any agent that can run a command.
          </p>
          <CopyBlock
            label="Agent prompt"
            copyLabel="Copy prompt"
            text={promptText}
            copied={isCopied("prompt", promptText)}
            onCopy={() => void copy("prompt", promptText)}
          />
        </section>
        <p className="text-prose text-pretty text-muted-foreground">
          Each prompt carries a one-time pairing secret: it works once, for 10 minutes, and the agent then asks to join,
          as a phone does.
        </p>
        <h3 className="text-base font-semibold text-foreground">Or set it up by hand</h3>
        <div className="flex flex-col gap-1.5">
          <p className="text-prose text-foreground">On the agent's computer, pair once:</p>
          <CopyBlock
            label="Pairing command"
            text={pairing}
            copied={isCopied("pair", pairing)}
            onCopy={() => void copy("pair", pairing)}
          />
          <p className="text-prose text-muted-foreground">
            {"Or type this code there: "}
            <span data-pair-code className="font-mono font-semibold tracking-widest text-foreground select-all">
              {offerCode(view.offer)}
            </span>
          </p>
        </div>
        <p className="text-prose text-foreground">Then add it to your agent:</p>
        <div className="flex flex-col">
          {AGENTS.map((agent) => {
            const snippet = agentSnippet(agent, view.offer.hostId);
            return (
              <div key={agent} className={cn(listRowClass, "flex-col items-stretch gap-2")}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-base text-foreground">{snippet.title}</p>
                  {snippet.where === null ? null : (
                    <p className="font-mono text-xs text-muted-foreground">{snippet.where}</p>
                  )}
                </div>
                <CopyBlock
                  label={`${snippet.title} config`}
                  copyLabel="Copy"
                  text={snippet.text}
                  copied={isCopied(agent, snippet.text)}
                  onCopy={() => void copy(agent, snippet.text)}
                />
              </div>
            );
          })}
        </div>
        {note === undefined ? null : <p className="text-prose text-pretty text-muted-foreground">{note}</p>}
        <p data-numeric="" className="text-xs text-muted-foreground">
          {expiryLine(view.offer, now)} It works once.
        </p>
      </div>
    );
  }

  if (view.kind === "paired") {
    const configText = hostId === null ? null : mcpConfig(hostId);
    return (
      <div className="flex flex-col gap-3">
        <p className="text-prose text-pretty text-muted-foreground">
          {view.device === null ? "A device" : view.device.name} is paired with this computer.
          {configText === null ? "" : " Paste this into the assistant's MCP settings:"}
        </p>
        {configText === null ? null : (
          <CopyBlock
            label="MCP settings config"
            copyLabel="Copy config"
            text={configText}
            copied={isCopied("config", configText)}
            onCopy={() => void copy("config", configText)}
          />
        )}
      </div>
    );
  }

  const notice =
    view.kind === "expired" ? (
      <Notice tone="warning" title="This invite expired">
        Open a new one to connect a client.
      </Notice>
    ) : (
      <Notice tone="warning" title="This computer's host did not answer">
        {view.reason}
      </Notice>
    );

  if (!inlineRetry) return notice;
  return (
    <div className="flex flex-col items-start gap-3">
      {notice}
      <Button variant="primary" onClick={again}>
        Open a new invite
      </Button>
    </div>
  );
}

function LiveAgentInvite({
  pair,
  open,
  inlineRetry,
}: {
  readonly pair: (request: "open" | "state") => Promise<DesktopPairAnswer>;
  readonly open: boolean;
  readonly inlineRetry: boolean;
}) {
  const offer = usePairOffer(pair, open);
  return <AgentInviteBody offer={offer} inlineRetry={inlineRetry} />;
}

/** Connects an AI agent over MCP: one prompt to paste into the agent, or per-agent config rows and a pairing code. */
export function AgentInvite({ pair, open = true, offer, inlineRetry = offer === undefined }: AgentInviteProps) {
  if (offer !== undefined) return <AgentInviteBody offer={offer} inlineRetry={inlineRetry} />;
  return <LiveAgentInvite pair={pair} open={open} inlineRetry={inlineRetry} />;
}
