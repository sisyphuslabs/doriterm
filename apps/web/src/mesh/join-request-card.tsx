import type { HcConnection } from "@doriface/client";
import { Button, IconButton, cn } from "@doriface/ui";
import { Monitor, Smartphone, X } from "lucide-react";
import { useState } from "react";
import { useWidthTier } from "../layout/width-tier.ts";
import { formatAge } from "../workspace/model.ts";
import { useNow } from "../workspace/use-now.ts";
import { refusalText, settledText } from "./attention.tsx";
import { pendingAnswer } from "./groups.ts";
import type { JoinRequest } from "./mesh-reader.ts";
import { useJoinAnswer } from "./use-join-answer.ts";
import { useMesh } from "./use-mesh.ts";

const grants = (request: JoinRequest): string =>
  request.join.kind === "client"
    ? "Approve only if it shows the same code. It will reach every machine in this mesh."
    : "Approve only if it shows the same code. It joins this mesh as a machine.";

interface CardProps {
  readonly request: JoinRequest;
  readonly holder: string;
  readonly now: number;
  readonly more: number;
  readonly compact: boolean;
  readonly onAnswer: (request: JoinRequest, verdict: "approve" | "deny") => Promise<void>;
  readonly onLater: () => void;
}

function Card({ request, holder, now, more, compact, onAnswer, onLater }: CardProps) {
  const { join } = request;
  const { busy, failure, send } = useJoinAnswer((verdict) => onAnswer(request, verdict));
  const state = pendingAnswer(join, now, request.answered);
  const shownFailure = failure ?? refusalText(join, holder, request.answered);
  const Icon = join.kind === "client" ? Smartphone : Monitor;
  const source = `Invite from ${holder} · ends in ${formatAge(0, Date.parse(join.expiresAt) - now)}${more > 0 ? ` · ${more} more in Settings` : ""}`;
  const buttons =
    state === "open" ? (
      <div className={cn("flex gap-2", compact && "flex-col-reverse")} data-mesh-answer="open">
        <Button
          size={compact ? "lg" : "md"}
          data-mesh-verdict="deny"
          loading={busy === "deny"}
          disabled={busy !== undefined}
          onClick={() => send("deny")}
        >
          Deny
        </Button>
        <Button
          size={compact ? "lg" : "md"}
          variant="primary"
          data-mesh-verdict="approve"
          loading={busy === "approve"}
          disabled={busy !== undefined || join.code === undefined}
          onClick={() => send("approve")}
        >
          Approve
        </Button>
      </div>
    ) : null;
  // Once answered the line takes the buttons' turn above the footer, so the footer's source never shrinks to fit it.
  const settled =
    state === "open" || state === "expired" ? null : (
      <p className="text-prose" data-mesh-answer={state}>
        {settledText(state, join.name, holder)}
      </p>
    );
  return (
    <section
      role="alertdialog"
      aria-labelledby="join-request-title"
      data-join-request={join.nonce}
      className={cn(
        "motion-arrive pointer-events-auto flex flex-col gap-3 border border-border bg-popover p-5 text-popover-foreground shadow-overlay [--arrive-duration:var(--duration-card)] [--arrive-ease:var(--ease-enter)] [--arrive-from:translateY(8px)]",
        compact ? "rounded-t-xl border-x-0 border-b-0 pb-[calc(var(--safe-bottom)+1.25rem)]" : "w-[25rem] rounded-xl",
      )}
    >
      <header className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="join-request-title" className="min-w-0 flex-1 truncate text-lg font-semibold">
          {`${join.name} wants to join`}
        </h2>
        <IconButton label="Not now" icon={<X />} onClick={onLater} />
      </header>
      {join.code === undefined ? (
        <p className="text-prose text-muted-foreground">Update the inviting machine to compare a join code.</p>
      ) : (
        <p aria-label="Join code" className="font-mono text-2xl tabular-nums">
          {join.code}
        </p>
      )}
      <p className="max-w-measure text-prose text-muted-foreground">{grants(request)}</p>
      {shownFailure === undefined ? null : <p className="text-prose text-status-blocked-text">{shownFailure}</p>}
      {settled}
      {compact ? (
        <>
          {buttons}
          <p className="text-center text-sm text-muted-foreground">{source}</p>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{source}</p>
          {buttons}
        </div>
      )}
    </section>
  );
}

/**
 * The trust step wherever the owner is looking (#2939): the first join waiting on any machine this app reaches, with
 * its code and what approving gives, answered on the machine that holds it. "Not now" hides that one join here; it
 * stays in Settings > Machines until its offer ends.
 */
export function JoinRequestCard({ connection }: { readonly connection: HcConnection }) {
  const { read, answer } = useMesh(connection);
  const now = useNow();
  const compact = useWidthTier() === "compact";
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  if (read.phase !== "ready") return null;
  const waiting = read.requests.filter(
    (request) => !later.has(request.join.nonce) && pendingAnswer(request.join, now, undefined) !== "expired",
  );
  const first = waiting[0];
  if (first === undefined) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-40 flex",
        compact ? "inset-x-0 bottom-0 flex-col" : "right-3 bottom-[calc(var(--statusbar-height)+0.75rem)] justify-end",
      )}
    >
      <Card
        key={first.join.nonce}
        request={first}
        holder={first.machine?.name ?? connection.hello.core.name}
        now={now}
        more={waiting.length - 1}
        compact={compact}
        onAnswer={answer}
        onLater={() => setLater((hidden) => new Set([...hidden, first.join.nonce]))}
      />
    </div>
  );
}
