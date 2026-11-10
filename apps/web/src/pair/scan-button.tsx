import { Button, Notice } from "@doriface/ui";
import { Camera } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanError, startScan } from "./scan.ts";

interface ScanFailureNotice {
  readonly title: string;
  readonly body: string;
}

function noticeOf(cause: unknown): ScanFailureNotice {
  if (cause instanceof ScanError) {
    if (cause.failure === "timeout") return { title: "No QR code was read", body: cause.message };
    if (cause.failure === "unsupported") return { title: "This browser cannot scan codes", body: cause.message };
    return { title: "The camera could not read the code", body: cause.message };
  }
  return {
    title: "The camera did not start",
    body: cause instanceof Error ? cause.message : String(cause),
  };
}

function isStopped(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (cause instanceof ScanError && cause.failure === "stopped");
}

/**
 * Returns the QR's raw text and leaves validation to the caller: the camera is untrusted input, so nothing here parses
 * or navigates on what it reads.
 */
export function ScanButton({ onText }: { readonly onText: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<ScanFailureNotice | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const deliver = useRef(onText);
  deliver.current = onText;

  const stop = useCallback((): void => {
    setOpen(false);
    setFailure(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      try {
        const text = await startScan({ video: video.current, signal: controller.signal });
        deliver.current(text);
        setOpen(false);
      } catch (cause) {
        if (isStopped(cause, controller.signal)) return;
        setFailure(noticeOf(cause));
        setOpen(false);
      }
    };
    void run();
    return () => controller.abort();
  }, [open]);

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {failure === null ? null : (
          <Notice tone="error" title={failure.title}>
            {failure.body}
          </Notice>
        )}
        <Button size="lg" onClick={() => setOpen(true)}>
          <Camera aria-hidden className="size-4" />
          Scan the QR code
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <video
        ref={video}
        muted
        playsInline
        aria-label="Camera preview, looking for the host's QR code"
        className="aspect-square w-full rounded-xl bg-black object-cover"
      />
      <p role="status" className="text-center text-prose text-muted-foreground">
        Point the camera at the host&apos;s QR code.
      </p>
      <Button variant="ghost" onClick={stop}>
        Stop scanning
      </Button>
    </div>
  );
}
