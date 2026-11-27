import { Button, EmptyState, Kbd } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Sparkles, SquareTerminal } from "lucide-react";
import { useActionKeys } from "../keys/use-action-keys.ts";

export function NoTerminal({ onNew }: { readonly onNew: () => void }) {
  const newTabKeys = useActionKeys("tab.new");
  const paletteKeys = useActionKeys("app.palette");
  return (
    <EmptyState
      className="flex-1 justify-center"
      icon={<SquareTerminal aria-hidden />}
      title="No terminal open"
      description="Start a shell on this host, or pick an agent or a space."
      actions={
        <div className="flex flex-col items-center gap-4">
          <Button variant="primary" onClick={onNew}>
            <span>New terminal</span>
            {newTabKeys === undefined ? null : <Kbd keys={newTabKeys} />}
          </Button>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {paletteKeys === undefined ? null : (
              <span className="inline-flex items-center gap-1.5">
                <Kbd keys={paletteKeys} />
                <span>Command palette</span>
              </span>
            )}
            <Link
              to="/settings"
              hash="skills"
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Sparkles aria-hidden className="size-3" />
              <span>Set up Agent Skills</span>
            </Link>
          </div>
        </div>
      }
    />
  );
}
