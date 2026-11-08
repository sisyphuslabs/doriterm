import type { HcConnection } from "@doriface/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MACHINE_REFRESH_MS } from "../workspace/use-machines.ts";
import { meshCallsOf, type MeshRead, MeshReader, type Verdict } from "./mesh-reader.ts";

export type { Verdict } from "./mesh-reader.ts";

export interface Mesh {
  readonly read: MeshRead;
  /** Settles once the documents, read again after the write, are shown. */
  readonly answer: (nonce: string, verdict: Verdict, code?: string) => Promise<void>;
}

/**
 * The `doriface-mesh` document with machine.list beside it to check it against, read on a timer while the page is
 * visible like the machine list, and again after this device answers a pending join.
 */
export function useMesh(connection: HcConnection): Mesh {
  const [read, setRead] = useState<MeshRead>({ phase: "loading" });
  const reader = useMemo(() => new MeshReader(meshCallsOf(connection)), [connection]);
  useEffect(() => {
    const stop = reader.subscribe(setRead);
    void reader.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reader.refresh();
    }, MACHINE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [reader]);
  const answer = useCallback(
    (nonce: string, verdict: Verdict, code?: string) => reader.answer(nonce, verdict, code),
    [reader],
  );
  return { read, answer };
}
