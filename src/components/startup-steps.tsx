import { Check } from "lucide-react";
import type { StartupStep } from "./startup-steps-types";
import { startupStepCounter } from "./startup-steps-utils";

/**
 * The five lines under the startup screen's progress bar (startup-steps-utils.ts plans them). A fixed status
 * column, a label that truncates and a detail that keeps its place at the right, so a long line never pushes the
 * others out of line. Pure markup, no effects or timers: the screen must stay cheap to mount.
 */
export function StartupSteps({ steps }: { steps: StartupStep[] }) {
	return (
		<ol data-startup-steps className="mt-4 w-full space-y-1.5 text-left text-[13px] text-neutral-500">
			{steps.map((step) => (
				<li
					key={step.id}
					data-startup-step={step.id}
					data-step-state={step.state}
					data-step-tone={step.warn ? "warn" : undefined}
					className={`grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 ${
						step.state === "running"
							? "font-semibold text-neutral-900"
							: step.state === "done"
								? "text-neutral-700"
								: "opacity-60"
					}`}
				>
					<span
						aria-hidden="true"
						className={`flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] ${
							step.state === "done"
								? step.warn
									? "border-amber-500 bg-amber-500 text-white"
									: "border-blue-600 bg-blue-600 text-white"
								: step.state === "running"
									? "animate-spin border-blue-600 border-r-transparent motion-reduce:animate-none motion-reduce:border-r-blue-600"
									: "border-neutral-300"
						}`}
					>
						{step.state === "done" && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
					</span>
					<span className="min-w-0 truncate" title={step.label}>
						{step.label}
					</span>
					<span
						className={`whitespace-nowrap text-[11px] tabular-nums ${
							step.warn ? "text-amber-700" : step.state === "running" ? "text-blue-700" : "text-neutral-500"
						}`}
					>
						{step.detail}
					</span>
				</li>
			))}
			<li
				aria-hidden="true"
				className="flex justify-end pt-1.5 text-[10px] uppercase tracking-[0.1em] text-neutral-400"
			>
				<span data-startup-step-counter className="tabular-nums">
					{startupStepCounter(steps)}
				</span>
			</li>
		</ol>
	);
}
