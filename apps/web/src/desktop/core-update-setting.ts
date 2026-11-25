import { bridgeMethod } from "./bridge.ts";

/** The renderer-side view of apps/desktop/src/shared/core-update.ts. */
export type CoreUpdateStatus =
  | { readonly state: "available"; readonly current: string; readonly version: string }
  | { readonly state: "current" | "updated" | "restored"; readonly version: string }
  | { readonly state: "unavailable" | "failed"; readonly message: string };

export interface CoreUpdateSetting {
  check(): Promise<CoreUpdateStatus>;
  apply(): Promise<CoreUpdateStatus>;
}

function readStatus(value: unknown): CoreUpdateStatus {
  if (typeof value === "object" && value !== null) {
    const state: unknown = Reflect.get(value, "state");
    const version: unknown = Reflect.get(value, "version");
    const current: unknown = Reflect.get(value, "current");
    const message: unknown = Reflect.get(value, "message");
    if (state === "available" && typeof version === "string" && typeof current === "string") {
      return { state, current, version };
    }
    if ((state === "current" || state === "updated" || state === "restored") && typeof version === "string") {
      return { state, version };
    }
    if ((state === "unavailable" || state === "failed") && typeof message === "string") return { state, message };
  }
  return { state: "failed", message: "Doriterm did not receive a core update status." };
}

export function coreUpdateSetting(scope: object = globalThis): CoreUpdateSetting | null {
  const check = bridgeMethod("checkCoreUpdate", scope);
  const apply = bridgeMethod("applyCoreUpdate", scope);
  if (check === null || apply === null) return null;
  return {
    check: async () => readStatus(await check()),
    apply: async () => readStatus(await apply()),
  };
}
