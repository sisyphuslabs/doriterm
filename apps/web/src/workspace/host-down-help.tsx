import { connectionStore } from "../connection/store.ts";
import { useHostDownWhy } from "./host-down.ts";
import { PHONE_LINE, PHONE_LINE_TEXT } from "./phone-line.ts";
import { RetryButton } from "./retry-button.tsx";

const tryNow = (): Promise<void> => Promise.resolve(connectionStore.retryNow());

/**
 * Past the grace, why the host cannot be reached as text on the page, beside its one action (#2464): in the status bar
 * on a desktop, in its own line under the header on a phone, which shows no tooltip. Never over the terminal.
 */
export function HostDownHelp({ phone = false }: { readonly phone?: boolean }) {
  const why = useHostDownWhy();
  if (why === null) return null;
  if (phone) {
    return (
      <div className={PHONE_LINE} data-host-down>
        <p className={PHONE_LINE_TEXT}>
          <span className="min-w-0 text-pretty break-words">{why}</span>
        </p>
        <RetryButton size="sm" className="-my-1 shrink-0" onRetry={tryNow} />
      </div>
    );
  }
  return (
    <span data-host-down className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-xs text-foreground" title={why}>
        {why}
      </span>
      <RetryButton size="sm" onRetry={tryNow} />
    </span>
  );
}
