import type { KeyProtection } from "@doriface/vault";
import { Button, Field, Input, Notice, Sheet, groupHeadingClass } from "@doriface/ui";
import { Monitor } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { SONIOX_DEFAULTS } from "../vault/mesh-vault.ts";
import { isSonioxHost } from "../voice/soniox-recognizer.ts";
import { meshVault, useMeshVault } from "../vault/use-mesh-vault.ts";

export interface SonioxKeySheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const PROTECTION_LABEL: Readonly<Record<KeyProtection, string>> = {
  "os-keystore": "OS key store",
  "non-extractable": "Non-extractable browser key",
  unprotected: "Unprotected key",
};

function validateBaseUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return "Enter an https Base URL, e.g. https://api.soniox.com.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a valid https URL.";
  }
  if (parsed.protocol !== "https:") return "Base URL must use https.";
  if (!isSonioxHost(parsed.hostname)) return "Base URL must be a soniox.com address.";
  return undefined;
}

/** Saves the Soniox API key, model, and Base URL into the mesh vault, encrypted on this device before it leaves. */
export function SonioxKeySheet({ open, onOpenChange }: SonioxKeySheetProps) {
  const snapshot = useMeshVault();
  const savedModel = snapshot.soniox.kind === "saved" ? snapshot.soniox.model : SONIOX_DEFAULTS.model;
  const savedBaseUrl = snapshot.soniox.kind === "saved" ? snapshot.soniox.baseUrl : SONIOX_DEFAULTS.baseUrl;

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(savedModel);
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [keyError, setKeyError] = useState<string | undefined>();
  const [urlError, setUrlError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const keyId = useId();
  const modelId = useId();
  const urlId = useId();
  const membersId = useId();

  const defaults = useRef({ model: savedModel, baseUrl: savedBaseUrl });
  defaults.current = { model: savedModel, baseUrl: savedBaseUrl };

  useEffect(() => {
    setApiKey("");
    setKeyError(undefined);
    setUrlError(undefined);
    setSaveError(undefined);
    if (open) {
      setModel(defaults.current.model);
      setBaseUrl(defaults.current.baseUrl);
    }
  }, [open]);

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setApiKey("");
      setKeyError(undefined);
      setUrlError(undefined);
      setSaveError(undefined);
    }
    onOpenChange(next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedKey = apiKey.trim();
    const nextKeyError = trimmedKey === "" ? "Enter your Soniox API key." : undefined;
    const nextUrlError = validateBaseUrl(baseUrl);
    setKeyError(nextKeyError);
    setUrlError(nextUrlError);
    setSaveError(undefined);
    if (nextKeyError !== undefined || nextUrlError !== undefined) return;

    const trimmedModel = model.trim() || SONIOX_DEFAULTS.model;
    const trimmedUrl = baseUrl.trim();
    setSaving(true);
    try {
      await meshVault.saveSoniox({ apiKey: trimmedKey, model: trimmedModel, baseUrl: trimmedUrl });
      setApiKey("");
      handleOpenChange(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="Soniox API key" side="bottom" open={open} onOpenChange={handleOpenChange}>
      <form
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
        className="mx-auto flex w-full max-w-lg flex-col gap-4"
      >
        <Field
          label="API key"
          htmlFor={keyId}
          hint="Paste the key from the Soniox console. It is encrypted on this device before it leaves."
          error={keyError}
        >
          <Input
            id={keyId}
            type="password"
            mono
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            invalid={keyError !== undefined}
            disabled={saving}
            onValueChange={(next: string) => {
              setApiKey(next);
              if (keyError !== undefined) setKeyError(undefined);
            }}
          />
        </Field>
        <Field label="Model" htmlFor={modelId}>
          <Input
            id={modelId}
            mono
            autoComplete="off"
            spellCheck={false}
            value={model}
            disabled={saving}
            onValueChange={(next: string) => setModel(next)}
          />
        </Field>
        <Field label="Base URL" htmlFor={urlId} hint="The key is used only with this address." error={urlError}>
          <Input
            id={urlId}
            type="url"
            mono
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            invalid={urlError !== undefined}
            disabled={saving}
            onValueChange={(next: string) => {
              setBaseUrl(next);
              if (urlError !== undefined) setUrlError(undefined);
            }}
          />
        </Field>
        <section aria-labelledby={membersId} className="flex flex-col gap-2">
          <h3 id={membersId} className={groupHeadingClass}>
            Who can open it (mesh members)
          </h3>
          {snapshot.members.length === 0 ? (
            <p className="text-prose text-muted-foreground">No mesh members listed yet.</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {snapshot.members.map((member) => (
                <li key={member.signPub} className="flex min-h-12 items-center gap-3 px-3 py-2.5">
                  <Monitor aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p
                      className={
                        member.self
                          ? "truncate text-base text-foreground"
                          : "truncate font-mono text-base text-foreground"
                      }
                    >
                      {member.self ? "This device" : member.signPub.slice(0, 8)}
                    </p>
                    <p className="text-prose text-pretty text-muted-foreground">
                      {member.opens ? "Holds the vault key" : "Gets it when it next connects"} ·{" "}
                      {PROTECTION_LABEL[member.protection]}
                    </p>
                  </div>
                  <span
                    aria-hidden
                    className={
                      member.opens
                        ? "size-2 shrink-0 rounded-full bg-primary"
                        : "size-2 shrink-0 rounded-full border border-muted-foreground/60"
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="text-prose text-pretty text-muted-foreground">
          Any connected machine can hand over the encrypted entry; each device decrypts it locally. Machines see only
          ciphertext.
        </p>
        {saveError === undefined ? null : (
          <Notice tone="error" title="Could not save the Soniox key">
            {saveError}
          </Notice>
        )}
        <Button type="submit" variant="primary" loading={saving} className="w-full">
          Save to mesh vault
        </Button>
      </form>
    </Sheet>
  );
}
