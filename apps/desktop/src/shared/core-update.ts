export interface CoreUpdateOffer {
  readonly state: "available";
  readonly current: string;
  readonly version: string;
}

export type CoreUpdateAnswer =
  | CoreUpdateOffer
  | { readonly state: "current" | "updated" | "restored"; readonly version: string }
  | { readonly state: "unavailable" | "failed"; readonly message: string };

export interface CoreUpdateBridge {
  checkCoreUpdate(): Promise<CoreUpdateAnswer>;
  applyCoreUpdate(): Promise<CoreUpdateAnswer>;
}

export const isCoreVersion = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

export function isCoreUpdateAnswer(value: unknown): value is CoreUpdateAnswer {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  const version: unknown = Reflect.get(value, "version");
  switch (state) {
    case "available":
      return isCoreVersion(version) && isCoreVersion(Reflect.get(value, "current"));
    case "current":
    case "updated":
    case "restored":
      return isCoreVersion(version);
    case "unavailable":
    case "failed":
      return typeof Reflect.get(value, "message") === "string";
    default:
      return false;
  }
}

export const coreUpdateChannels = {
  check: "doriface:check-core-update",
  apply: "doriface:apply-core-update",
} as const;
