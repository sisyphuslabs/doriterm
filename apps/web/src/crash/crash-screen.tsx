import { Button } from "@doriface/ui";
import { CircleAlert } from "lucide-react";
import { CopyDetails } from "./copy-details.tsx";

export interface CrashScreenProps {
  readonly error: unknown;
  /** Draws the screen that threw again (a route's error); without it only Reload is offered. */
  readonly onRetry?: () => void;
}

/**
 * What the window shows when a render error reached the app or a whole screen. It needs no provider, so it still draws
 * when one of them is what threw. An installed app has no reload button of its own: Reload is that button.
 */
export function CrashScreen({ error, onRetry }: CrashScreenProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div role="alert" className="flex w-full max-w-md flex-col gap-4">
        <div className="flex items-center gap-2">
          <CircleAlert aria-hidden className="size-5 shrink-0 text-status-blocked-text" />
          <h1 className="text-xl font-semibold">Doriterm stopped drawing</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          It hit an error it could not draw past. Your terminals keep running on the host.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
          {onRetry === undefined ? null : <Button onClick={onRetry}>Try again</Button>}
        </div>
        <CopyDetails error={error} />
      </div>
    </main>
  );
}
