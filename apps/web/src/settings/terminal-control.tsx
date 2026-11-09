import { IconButton, Input, NumberStepper, SegmentedControl, Switch, cn } from "@doriface/ui";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyDef } from "../ghostty/schema.ts";
import { checkValue, parseColor } from "../ghostty/values.ts";

export interface KeyControlProps {
  readonly def: KeyDef;
  readonly values: readonly string[];
  readonly disabled: boolean;
  /** Called only with values the key accepts; invalid text stays in the field with its reason. */
  readonly onCommit: (values: readonly string[]) => void;
  readonly onInvalid: (reason: string | null) => void;
}

const OPTIONAL_BOOL = [
  { value: "", label: "Programs" },
  { value: "true", label: "On" },
  { value: "false", label: "Off" },
] as const;

/** One text value, committed on blur or Enter after the key's own check. */
function TextValue({
  def,
  value,
  disabled,
  placeholder,
  autoFocus,
  onCommit,
  onEnterCommit,
  onInvalid,
}: {
  readonly def: KeyDef;
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly onCommit: (value: string) => void;
  /** After onCommit, when Enter (not a blur) committed a changed, valid value. */
  readonly onEnterCommit?: () => void;
  readonly onInvalid: (reason: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(value), [value]);
  /** True when the value was committed. */
  const commit = (): boolean => {
    if (draft === value) {
      setInvalid(false);
      onInvalid(null);
      return false;
    }
    const checked = draft === "" ? { ok: true as const } : checkValue(def.kind, draft);
    setInvalid(!checked.ok);
    onInvalid(checked.ok ? null : checked.reason);
    if (checked.ok) onCommit(draft);
    return checked.ok;
  };
  const swatch = def.kind.type === "color" ? parseColor(draft) : null;
  return (
    <span className="relative flex w-full items-center sm:w-56">
      {swatch === null ? null : (
        <span
          aria-hidden
          className="absolute left-2.5 size-3.5 rounded-xs border border-border"
          style={{ background: swatch }}
        />
      )}
      <Input
        aria-label={def.key}
        mono
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        invalid={invalid}
        value={draft}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(autoFocus === undefined ? {} : { autoFocus })}
        className={cn(swatch === null ? "" : "pl-8")}
        onValueChange={(next: string) => setDraft(next)}
        onBlur={(event) => {
          const field = event.currentTarget;
          // Settings moving between its dialog and its sheet blurs this field and hands focus straight back (#1160):
          // that blur is the move's, not the reader leaving, so it must not commit a draft they are still typing. A
          // real blur has focus elsewhere by the first microtask, as the key recorder's own check finds (#859).
          queueMicrotask(() => {
            if (document.activeElement !== field) commit();
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Consumed: a commit can move focus to a button, which would take this same Enter as a click.
          event.preventDefault();
          if (commit()) onEnterCommit?.();
        }}
      />
    </span>
  );
}

/** Repeatable keys: one field per line of the config, plus one to add the next. */
/** Each entry reports its own error; the row shows the first one still invalid. */
function useEntryErrors(
  onInvalid: (reason: string | null) => void,
): (entry: string) => (reason: string | null) => void {
  const errors = useRef(new Map<string, string>());
  return (entry) => (reason) => {
    if (reason === null) errors.current.delete(entry);
    else errors.current.set(entry, reason);
    onInvalid(errors.current.values().next().value ?? null);
  };
}

function ListValue({ def, values, disabled, onCommit, onInvalid }: KeyControlProps) {
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // Set only when Enter committed the new field and closed it: focus goes back to Add instead of the page body.
  const backToAdd = useRef(false);
  useEffect(() => {
    if (adding || !backToAdd.current) return;
    backToAdd.current = false;
    addButton.current?.focus();
  }, [adding]);
  const errorFor = useEntryErrors(onInvalid);
  const set = (index: number, value: string): void => {
    const next = values.map((entry, at) => (at === index ? value : entry)).filter((entry) => entry !== "");
    onCommit(next);
  };
  return (
    <ul className="flex w-full flex-col gap-1.5 sm:w-auto">
      {values.map((value, index) => (
        <li key={`${index}-${value}`} className="flex items-center gap-1">
          <TextValue
            def={def}
            value={value}
            disabled={disabled}
            onCommit={(next) => set(index, next)}
            onInvalid={errorFor(`entry-${index}`)}
          />
          <IconButton label={`Remove ${value}`} icon={<X />} disabled={disabled} onClick={() => set(index, "")} />
        </li>
      ))}
      <li className="flex items-center gap-1">
        {adding ? (
          <TextValue
            def={def}
            value=""
            disabled={disabled}
            autoFocus
            placeholder={PLACEHOLDER[def.kind.type] ?? ""}
            onCommit={(next) => {
              setAdding(false);
              if (next !== "") onCommit([...values, next]);
            }}
            onEnterCommit={() => {
              backToAdd.current = true;
            }}
            onInvalid={errorFor("new")}
          />
        ) : (
          <IconButton
            ref={addButton}
            label={`Add ${def.key}`}
            icon={<Plus />}
            disabled={disabled}
            onClick={() => setAdding(true)}
          />
        )}
      </li>
    </ul>
  );
}

const PLACEHOLDER: Readonly<Record<string, string>> = {
  text: "Family name",
  feature: "-calt",
  variation: "wght=500",
  palette: "0=#000000",
  color: "#rrggbb",
  metric: "10%",
  padding: "4,8",
  theme: "light:Day,dark:Night",
};

/** The control for a key, chosen by the key's kind. */
export function KeyControl(props: KeyControlProps) {
  const { def, values, disabled, onCommit, onInvalid } = props;
  const value = values.at(-1) ?? "";
  const kind = def.kind;
  if (def.repeatable) return <ListValue {...props} />;
  switch (kind.type) {
    case "bool":
      return (
        <span className="flex">
          <Switch
            aria-label={def.key}
            disabled={disabled}
            checked={value === "true"}
            onCheckedChange={(checked) => onCommit([checked ? "true" : "false"])}
          />
        </span>
      );
    case "optional-bool":
      return (
        <SegmentedControl
          label={def.key}
          disabled={disabled}
          options={OPTIONAL_BOOL}
          value={value}
          onValueChange={(next) => onCommit([next])}
        />
      );
    case "enum":
      return (
        <SegmentedControl
          label={def.key}
          disabled={disabled}
          options={kind.values.map((entry) => ({ value: entry, label: entry.replace("_", " ") }))}
          value={value}
          onValueChange={(next) => onCommit([next])}
        />
      );
    case "number":
      return (
        <NumberStepper
          label={def.key}
          disabled={disabled}
          min={kind.min}
          max={kind.max}
          step={kind.step}
          value={Number(value)}
          onValueChange={(next) => {
            if (next !== null) onCommit([String(next)]);
          }}
        />
      );
    default:
      return (
        <TextValue
          def={def}
          value={value}
          disabled={disabled}
          placeholder={PLACEHOLDER[kind.type] ?? ""}
          onCommit={(next) => onCommit(next === "" ? [] : [next])}
          onInvalid={onInvalid}
        />
      );
  }
}
