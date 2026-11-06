import { Button, cn } from "@doriface/ui";
import { Check } from "lucide-react";
import { type GuideFacts, guideStore, guideSteps, useGuide } from "./first-run-guide.ts";

export interface FirstRunGuideCardProps extends GuideFacts {
  readonly onNew: () => void;
  readonly className?: string;
}

/**
 * The first-run steps on a newly paired device (#668), while the guide runs: each step's state, a Start a terminal button
 * for the current agent step, Skip, and Done once every step is done. Renders nothing otherwise.
 */
export function FirstRunGuideCard({ onNew, className, ...facts }: FirstRunGuideCardProps) {
  const guide = useGuide();
  if (guide.status !== "active") return null;
  const steps = guideSteps(guide, facts);
  const finished = steps.every((step) => step.state === "done");
  const agentCurrent = steps.some((step) => step.id === "agent" && step.state === "current");
  return (
    <section
      aria-label="Getting started"
      className={cn("m-3 flex flex-col gap-3 rounded-lg border border-border bg-raised p-4 text-sm", className)}
    >
      <h2 className="font-semibold text-foreground">{finished ? "You're set" : "Getting started"}</h2>
      <ol aria-label="Getting started steps" className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2",
              step.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {step.state === "done" ? (
              <Check aria-label="done" className="size-4 text-brand" />
            ) : (
              <span data-numeric aria-hidden className="w-4 text-center">
                {index + 1}
              </span>
            )}
            {step.label}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {finished ? (
          <Button variant="primary" onClick={() => guideStore.finish()}>
            Done
          </Button>
        ) : (
          <>
            {agentCurrent ? (
              <Button variant="primary" onClick={onNew}>
                Start a terminal
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => guideStore.skip()}>
              Skip
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
