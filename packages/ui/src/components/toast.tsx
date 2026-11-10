import { Toast as BaseToast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { overlaySurface } from "./overlay.ts";

export const ToastProvider = BaseToast.Provider;
export const useToastManager = BaseToast.useToastManager;

const DOT: Readonly<Record<string, string>> = {
  error: "bg-status-blocked",
  warning: "bg-status-working",
  success: "bg-status-done",
  info: "bg-muted-foreground",
};

/** Outcomes that are not visible in place. Bottom-right, popover tone, a level dot plus words. */
export interface ToastViewportProps {
  readonly className?: string;
  /** Mounts the stack inside this element instead of the page corner, e.g. for previews. */
  readonly container?: HTMLElement | null;
}

export function ToastViewport({ className, container }: ToastViewportProps) {
  const { toasts } = BaseToast.useToastManager();
  return (
    <BaseToast.Portal {...(container === undefined ? {} : { container })}>
      <BaseToast.Viewport
        className={cn(
          container === undefined ? "fixed right-4 bottom-4 z-50" : "relative",
          "flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2",
          className,
        )}
      >
        {toasts.map((toast) => (
          <BaseToast.Root key={toast.id} toast={toast} className={cn(overlaySurface, "flex items-start gap-3 p-3")}>
            <span
              aria-hidden
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[toast.type ?? "info"] ?? DOT["info"])}
            />
            <BaseToast.Content className="min-w-0 flex-1">
              <BaseToast.Title className="text-sm font-semibold" />
              <BaseToast.Description className="text-sm text-muted-foreground" />
              {/* The toast's next step (DESIGN.md 5(f)), e.g. Retry: only a toast that names one gets a button. */}
              {toast.actionProps === undefined ? null : (
                <BaseToast.Action className="mt-2 rounded-md border border-border px-2 py-0.5 text-sm font-medium outline-none hover:bg-selected focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring" />
              )}
            </BaseToast.Content>
            <BaseToast.Close
              aria-label="Dismiss"
              className="rounded-xs p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring [&_svg:not([data-slot=spinner])]:size-3.5"
            >
              <X />
            </BaseToast.Close>
          </BaseToast.Root>
        ))}
      </BaseToast.Viewport>
    </BaseToast.Portal>
  );
}
