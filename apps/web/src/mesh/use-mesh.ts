import type { HcConnection } from "@doriface/client";
import { useCallback, useEffect, useState } from "react";
import { MACHINE_REFRESH_MS } from "../workspace/use-machines.ts";
import { meshCallsOf, type MeshRead, MeshReader, type Verdict } from "./mesh-reader.ts";

export type { MeshRead, Verdict } from "./mesh-reader.ts";

export interface Mesh {
  readonly read: MeshRead;
  /** Settles once the documents, read again after the write, are shown. */
  readonly answer: (nonce: string, verdict: Verdict) => Promise<void>;
}

/**
 * The `doriface-mesh` document with machine.list beside it to check it against, read on a timer while the page is
 * visible like the machine list, and again after this device answers a pending join.
 */
export function useMesh(connection: HcConnection): Mesh {
  const [read, setRead] = useState<MeshRead>({ phase: "loading" });
  const [reader, setReader] = useState<MeshReader | undefined>(undefined);
  useEffect(() => {
    const next = new MeshReader(meshCallsOf(connection), setRead);
    setReader(next);
    void next.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void next.refresh();
    }, MACHINE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      next.close();
    };
  }, [connection]);
  const answer = useCallback(
    async (nonce: string, verdict: Verdict): Promise<void> => {
      if (reader === undefined) throw new Error("the mesh status has not been read yet");
      await reader.answer(nonce, verdict);
    },
    [reader],
  );
  return { read, answer };
}
