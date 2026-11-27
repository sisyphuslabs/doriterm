import type { HcConnection } from "@doriface/client";
import {
  HOST_INFO_DOC,
  type MachineView,
  type SkillDirStatus,
  type SkillStatus,
  type Terminal,
} from "@doriface/protocol";
import { Button, CopyBlock, Notice, Spinner, cn, useToastManager } from "@doriface/ui";
import { AlertCircle, CheckCircle2, CircleDashed, Info, Monitor, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopBridge } from "../desktop/bridge.ts";
import { useConnection, useConnectionSettings } from "../connection/store.ts";
import { rosterFor } from "../roster/roster.ts";
import { useMachines } from "../workspace/use-machines.ts";
import { readSkill, requestSkill, type SkillLink, skillLine } from "./agent-skill.ts";
import { Subgroup, sectionStackClass } from "./settings-layout.tsx";

const NO_TERMINALS: readonly Terminal[] = [];
const CLI_INSTALL_CMD = "doriface-host skill install";

type LoadState = { readonly loaded: false } | { readonly loaded: true; readonly skill: SkillStatus | undefined };

function dirIcon(state: SkillDirStatus["state"]) {
  switch (state) {
    case "installed":
      return <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-online" />;
    case "outdated":
      return <AlertCircle aria-hidden className="size-3.5 shrink-0 text-status-working" />;
    case "missing":
      return <CircleDashed aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />;
    case "foreign":
      return <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function dirStateLabel(entry: SkillDirStatus): string {
  switch (entry.state) {
    case "installed":
      return entry.version === undefined ? "Installed" : `v${entry.version}`;
    case "outdated":
      return entry.version === undefined ? "Update available" : `v${entry.version} · outdated`;
    case "missing":
      return "Not installed";
    case "foreign":
      return "Unmanaged";
  }
}

function MachineSkillCard({
  connection,
  machine,
  name,
  subtitle,
  local,
  offline = false,
}: {
  readonly connection: HcConnection | null;
  readonly machine: string | undefined;
  readonly name: string;
  readonly subtitle: string;
  readonly local: boolean;
  readonly offline?: boolean;
}) {
  const toasts = useToastManager();
  const [state, setState] = useState<LoadState>({ loaded: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const link = useMemo((): SkillLink | null => {
    if (connection === null || offline) return null;
    return {
      call: connection.call.bind(connection),
      onDoc: (listener) => rosterFor(connection).onDoc(listener),
      onGap: (listener) => rosterFor(connection).onGap(listener),
    };
  }, [connection, offline]);

  useEffect(() => {
    if (connection === null || link === null) return undefined;
    let live = true;
    const refresh = (): void => {
      void (async () => {
        const result = await readSkill(link, machine);
        if (live) setState({ loaded: true, skill: result?.skill });
      })();
    };
    refresh();
    const roster = rosterFor(connection);
    const stops = [
      roster.subscribe(() => undefined),
      link.onDoc((on, doc) => (on === (machine ?? null) && doc === HOST_INFO_DOC ? refresh() : undefined)),
      link.onGap(refresh),
    ];
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [connection, link, machine]);

  const install = useCallback(() => {
    if (link === null) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        const next = await requestSkill(link, machine);
        setState({ loaded: true, skill: next });
        const paths = next.dirs
          .filter((entry) => entry.state === "installed")
          .map((entry) => entry.dir)
          .join(", ");
        toasts.add({
          type: "info",
          title: `Agent skill ready on ${name}`,
          description: paths === "" ? "The host updated its agent skill." : `Installed in ${paths}`,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [link, machine, name, toasts]);

  const Icon = local ? Monitor : Server;
  const line = state.loaded ? skillLine(state.skill) : null;
  const actionLabel = line?.action === "update" ? "Update" : line?.action === "install" ? "Install" : null;
  const dirs = state.loaded ? (state.skill?.dirs ?? []) : [];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/55 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted-foreground">
            <Icon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-medium text-foreground">{name}</p>
              <span className="text-xs text-muted-foreground">{subtitle}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {offline ? (
                "Offline — connect this machine to manage its skill."
              ) : !state.loaded ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner />
                  Checking skill status…
                </span>
              ) : (
                (line?.text ?? "Agent skill status unavailable")
              )}
            </p>
          </div>
        </div>
        {!offline && actionLabel !== null ? (
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            aria-label={`${actionLabel} agent skill on ${name}`}
            onClick={install}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>

      {dirs.length > 0 ? (
        <ul
          aria-label={`Skill directories on ${name}`}
          className="flex flex-col divide-y divide-border rounded-md border border-border/80 bg-background/60"
        >
          {dirs.map((entry) => (
            <li key={entry.dir} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                {dirIcon(entry.state)}
                <code className="truncate font-mono text-foreground">{entry.dir}</code>
              </span>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap",
                  entry.state === "installed"
                    ? "text-online"
                    : entry.state === "outdated"
                      ? "text-status-working-text"
                      : "text-muted-foreground",
                )}
              >
                {dirStateLabel(entry)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error === undefined ? null : (
        <Notice tone="error" title="Could not update agent skill">
          {error}
        </Notice>
      )}
    </div>
  );
}

function ConnectedSkills({ connection }: { readonly connection: HcConnection }) {
  const settings = useConnectionSettings();
  const ownComputer = desktopBridge() !== null && settings.mode === "loopback";
  const { views } = useMachines(connection, NO_TERMINALS);
  return (
    <div className="flex flex-col gap-3">
      <MachineSkillCard
        connection={connection}
        machine={undefined}
        name={connection.hello.core.name}
        subtitle={ownComputer ? "This machine" : "Primary host"}
        local
      />
      {views.map((view: MachineView) => (
        <MachineSkillCard
          key={view.id}
          connection={connection}
          machine={view.name}
          name={view.name}
          subtitle={view.state === "connected" ? "Connected" : "Offline"}
          local={false}
          offline={view.state !== "connected"}
        />
      ))}
    </div>
  );
}

/** Dedicated Agent Skills management screen: 1-click per-machine install/update, directory audit, and CLI fallback. */
export function AgentSkillsSection() {
  const state = useConnection();
  const connection = state.phase === "open" ? state.connection : null;
  const [copied, setCopied] = useState(false);
  const copyCommand = useCallback(() => {
    void (async () => {
      await navigator.clipboard.writeText(CLI_INSTALL_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    })();
  }, []);

  return (
    <div className={sectionStackClass}>
      <p className="max-w-measure text-prose text-pretty text-muted-foreground">
        Install the doriterm skill so coding agents like Claude Code, Codex, and OpenCode can start, inspect, and
        coordinate terminals on each machine.
      </p>

      {connection === null ? (
        <Notice tone="info" title="Not connected">
          Connect to your host to inspect and install the agent skill.
        </Notice>
      ) : (
        <ConnectedSkills connection={connection} />
      )}

      <Subgroup title="Manual CLI install">
        <div className="flex flex-col gap-2 py-3">
          <p className="text-prose text-muted-foreground">
            Prefer the terminal or setting up a headless machine? Run this command on the host:
          </p>
          <CopyBlock label="Install agent skill command" text={CLI_INSTALL_CMD} copied={copied} onCopy={copyCommand} />
        </div>
      </Subgroup>
    </div>
  );
}
