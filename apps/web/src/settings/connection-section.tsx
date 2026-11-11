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

/** The part of the connection store the Advanced form uses: the settings it reads and the edit that saves one field. */
export interface ConnectionFormStore {
  readonly settings: ConnectionSettings;
  edit(fields: Partial<ConnectionSettings>): void;
}

export interface ConnectionForm {
  /** The fields being typed, seeded once: typing is never overwritten by a change behind the form. */
  readonly draft: ConnectionSettings;
  type<K extends keyof ConnectionSettings>(field: K, value: ConnectionSettings[K]): void;
  /**
   * Saves one field onto the settings as they are now, never the copy the form opened with: the shown machine and the
   * roster move on their own while the form is open (#1006).
   */
  commit<K extends keyof ConnectionSettings>(field: K, value: ConnectionSettings[K]): void;
  /** A field the person leaves: saved only if what was typed differs from that store's settings now (#2023). */
  leave<K extends keyof ConnectionSettings>(field: K): void;
}

/** The Advanced form's state, apart from its markup, so a test can mount it and save a field after another pick (#1169). */
export function useConnectionForm(store: ConnectionFormStore = connectionStore): ConnectionForm {
  const [draft, setDraft] = useState<ConnectionSettings>(store.settings);
  const change = <K extends keyof ConnectionSettings>(field: K, value: ConnectionSettings[K]): void => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };
  const commit = <K extends keyof ConnectionSettings>(field: K, value: ConnectionSettings[K]): void => {
    change(field, value);
    store.edit({ [field]: value } as Partial<ConnectionSettings>);
  };
  return {
    draft,
    type: change,
    commit,
    leave: (field) => {
      if (draft[field] !== store.settings[field]) commit(field, draft[field]);
    },
  };
}

/**
 * Relay (end-to-end encrypted) or the plaintext loopback dev gateway. The relay is shown with no field to change it and
 * there is no direct address (#458): a release build always reaches the production relay and offers no loopback switch,
 * and a dev build reads another relay and a direct address only from saved settings (`doriface.connection`).
 */
export function ConnectionSection() {
  const form = useConnectionForm();
  const { draft } = form;
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
          onValueChange={(value: string) => form.type(id, value)}
          onBlur={() => form.leave(id)}
          onKeyDown={(event) => {
            if (event.key === "Enter") form.commit(id, draft[id]);
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
            onValueChange={(mode) => form.commit("mode", mode)}
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
