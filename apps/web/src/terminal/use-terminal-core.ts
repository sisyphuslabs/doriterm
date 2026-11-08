import { loadGhosttyCore } from "@doriface/ghostty-wasm";
import type { GhosttyCore } from "@wterm/ghostty";
import { useEffect, useState } from "react";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";

/** The view's libghostty engine, loaded once the stored config is; freed once the view closes and its renderer is gone. */
export function useTerminalCore(): { readonly core: GhosttyCore | null; readonly error: string | null } {
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    // scrollback-limit applies to new terminals, so the core reads it once, after the stored config loads.
    terminalConfigStore.loaded
      .then(() => loadGhosttyCore({ scrollbackLimit: rendererOptions(terminalConfigStore.config).scrollbackBytes }))
      .then(
        (loaded) => (mounted ? setCore(loaded) : loaded.dispose()),
        (cause: unknown) => setError(`The terminal renderer failed to load: ${String(cause)}`),
      );
    return () => {
      mounted = false;
    };
  }, []);

  // The terminal's engine, with its scrollback and images, is freed once the view closes and its renderer is gone.
  useEffect(() => {
    if (core === null) return undefined;
    return () => queueMicrotask(() => core.dispose());
  }, [core]);
  return { core, error };
}
