/** Where a key's value takes effect in the @wterm/ghostty DOM renderer. */
export type Support =
  | { readonly level: "live" }
  | { readonly level: "new-terminals" }
  | { readonly level: "unsupported"; readonly reason: string };

export type Group = "font" | "cursor" | "colors" | "spacing" | "behavior";

export type Kind =
  | { readonly type: "text" }
  | { readonly type: "number"; readonly min: number; readonly max: number; readonly step: number }
  | { readonly type: "integer"; readonly min: number; readonly max: number }
  | { readonly type: "bool" }
  | { readonly type: "optional-bool" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "color"; readonly cellColors: boolean }
  | { readonly type: "metric" }
  | { readonly type: "palette" }
  | { readonly type: "feature" }
  | { readonly type: "variation" }
  | { readonly type: "theme" }
  | { readonly type: "padding" };

export interface KeyDef {
  /** Ghostty's own key name. */
  readonly key: string;
  /** A plain label when the control's name differs from the config key. */
  readonly label?: string;
  readonly group: Group;
  readonly kind: Kind;
  /** Repeatable keys collect every line (font-family fallbacks, palette entries). */
  readonly repeatable: boolean;
  /** The value used when the key is unset, in Ghostty's config syntax. */
  readonly defaults: readonly string[];
  readonly description: string;
  readonly support: Support;
}

export const LIVE: Support = { level: "live" };
export const NEW_TERMINALS: Support = { level: "new-terminals" };
export const unsupported = (reason: string): Support => ({ level: "unsupported", reason });

export const GROUP_LABEL: Readonly<Record<Group, string>> = {
  font: "Font",
  cursor: "Cursor",
  colors: "Colors",
  spacing: "Spacing",
  behavior: "Behavior",
};
