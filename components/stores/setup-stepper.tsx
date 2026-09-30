import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type Step = { id: string; title: string };

/** Horizontal step indicator; collapses to "Step n of m" on small screens. */
export function SetupStepper({ steps, current }: { steps: Step[]; current: number }) {
  return (
    <nav aria-label="Setup progress">
      <p className="text-sm text-muted-foreground lg:hidden">
        Step {current + 1} of {steps.length} · <span className="font-medium text-foreground">{steps[current]?.title}</span>
      </p>
      <ol className="hidden items-center gap-2 lg:flex">
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2 last:flex-none">
              <span
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-foreground",
                  !done && !active && "text-muted-foreground",
                )}
              >
                {done ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <span className={cn("text-sm whitespace-nowrap", active ? "font-medium" : "text-muted-foreground")}>
                {step.title}
              </span>
              {i < steps.length - 1 ? <span className="h-px min-w-4 flex-1 bg-border" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
