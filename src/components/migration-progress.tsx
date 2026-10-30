"use client";

import { CheckCircle2, Circle, Database, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useElapsedSeconds, type MigrationApplyState } from "./migration-apply";
import { formatElapsed, migrationProgressView, type MigrationStepState } from "./migration-progress-utils";

function StepIcon({ state }: { state: MigrationStepState }) {
	if (state === "done") return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
	if (state === "active")
		return <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />;
	return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />;
}

/** The steps, a bar and a counter for a running update; the same in the admin card and the mailbox notice. */
export function MigrationApplyProgress({ progress }: { progress: MigrationApplyState }) {
	const elapsed = useElapsedSeconds(progress.startedAt);
	const view = migrationProgressView(progress.startNames, progress.remaining, progress.recovering);
	const determinate = view.done > 0 && view.total > 0;

	return (
		<div className="mt-3 text-xs" data-testid="migration-progress">
			<p className="sr-only" role="status" aria-live="polite">
				{view.announcement}
			</p>
			<ol aria-label="Update progress" className="space-y-1">
				{view.steps.map((step) => (
					<li
						key={step.id}
						aria-current={step.state === "active" ? "step" : undefined}
						className={`flex items-start gap-2 break-words ${step.state === "waiting" ? "opacity-70" : "font-medium"}`}
					>
						<StepIcon state={step.state} />
						<span className="min-w-0">{step.label}</span>
					</li>
				))}
			</ol>
			{view.notice && <p className="mt-1.5 font-medium">{view.notice}</p>}
			<div
				role="progressbar"
				aria-label="Database update progress"
				aria-valuemin={0}
				aria-valuemax={determinate ? view.total : undefined}
				aria-valuenow={determinate ? view.done : undefined}
				className="mt-2 h-1.5 overflow-hidden rounded-full bg-current/15"
			>
				<div
					className={`h-full rounded-full bg-current/60 ${determinate ? "transition-[width]" : "w-full motion-safe:animate-pulse"}`}
					style={determinate ? { width: `${(view.done / view.total) * 100}%` } : undefined}
				/>
			</div>
			<p className="mt-1.5 opacity-90">
				<span aria-hidden="true">Elapsed: {formatElapsed(elapsed)}. </span>
				Keep this page open until it finishes.
			</p>
		</div>
	);
}

/** One button for every place that starts an update: busy while it runs, so it cannot be pressed twice. */
export function MigrationApplyButton({
	busy,
	idleLabel,
	onClick,
	size = "sm",
	className,
	showIcon = false,
}: {
	busy: boolean;
	idleLabel: string;
	onClick: () => void;
	size?: "sm" | "lg";
	className?: string;
	showIcon?: boolean;
}) {
	return (
		<Button type="button" size={size} onClick={onClick} disabled={busy} aria-busy={busy} className={className}>
			{busy ? (
				<Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
			) : showIcon ? (
				<Database className="h-4 w-4" aria-hidden="true" />
			) : null}
			{busy ? "Updating database…" : idleLabel}
		</Button>
	);
}
