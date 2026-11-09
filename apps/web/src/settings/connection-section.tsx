import { Input, SegmentedControl, SettingRow } from "@doriface/ui";
import { useState } from "react";
import { type ConnectionMode, type ConnectionSettings, DEV_BUILD } from "../connection/settings.ts";
import { connectionStore } from "../connection/store.ts";

const MODES = [
  { value: "relay", label: "Relay" },
  { value: "loopback", label: "Loopback dev" },
] as const;

type TextField = "loopbackUrl" | "token";

/** A relay as people read it: its host name, without the scheme. */
const relayHost = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/**
 * Relay (end-to-end encrypted) or the plaintext loopback dev gateway. The relay is shown with no field to change it and
 * there is no direct address (#458): a release build always reaches the production relay and offers no loopback switch,
 * and a dev build reads another relay and a direct address only from saved settings (`doriface.connection`).
 */
export function ConnectionSection() {
  // The fields being typed; a commit applies only the one changed, to the settings as they are then (#1006).
  const [draft, setDraft] = useState<ConnectionSettings>(connectionStore.settings);
  const commit = (fields: Partial<ConnectionSettings>): void => {
    setDraft((prev) => ({ ...prev, ...fields }));
    connectionStore.edit(fields);
  };
  const row = (id: TextField, title: string, description: string, secret = false) => (
    <SettingRow
      id={id}
      title={title}
      description={description}
      control={
        <Input
          aria-label={title}
          mono
          type={secret ? "password" : "text"}
          inputMode={id === "loopbackUrl" ? "url" : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          value={draft[id]}
          className="w-full sm:w-64"
          onValueChange={(value: string) => setDraft((prev) => ({ ...prev, [id]: value }))}
          onBlur={(event) => {
            const field = event.currentTarget;
            // Settings moving between its dialog and its sheet blurs this field and hands focus straight back (#1160):
            // that blur is the move's, not the reader leaving, so it must not save a draft they are still typing. A
            // real blur has focus elsewhere by the first microtask, as the key recorder's own check finds (#859).
            queueMicrotask(() => {
              if (document.activeElement !== field && draft[id] !== connectionStore.settings[id])
                commit({ [id]: draft[id] });
            });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit({ [id]: draft[id] });
          }}
        />
      }
    />
  );

  const relay = (
    <SettingRow
      title="Relay"
      description="Works from anywhere and only forwards encrypted traffic."
      control={<span className="font-mono text-sm text-muted-foreground">{relayHost(draft.relayUrl)}</span>}
    />
  );

  if (!DEV_BUILD) {
    return draft.mode === "relay" ? (
      relay
    ) : (
      <>
        {row("loopbackUrl", "Gateway", "The /v1/hc address doriface-host prints.")}
        {row("token", "Token", "Printed by doriface-host --print-token.", true)}
      </>
    );
  }

  return (
    <>
      <SettingRow
        title="Connect through"
        description={
          draft.mode === "relay"
            ? "The relay works from anywhere and only forwards encrypted traffic."
            : "Talks to doriface-host on this machine in plain text. For development only."
        }
        control={
          <SegmentedControl<ConnectionMode>
            label="Connect through"
            options={MODES}
            value={draft.mode}
            onValueChange={(mode) => commit({ mode })}
          />
        }
      />
      {draft.mode === "relay" ? (
        relay
      ) : (
        <>
          {row("loopbackUrl", "Gateway", "The /v1/hc address doriface-host prints.")}
          {row("token", "Token", "Printed by doriface-host --print-token.", true)}
        </>
      )}
    </>
  );
}
