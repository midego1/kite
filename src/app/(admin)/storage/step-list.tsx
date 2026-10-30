"use client";

import { useId, useState } from "react";
import { CheckCircle2, Circle, Info, XCircle } from "lucide-react";
import { corsRuleJson } from "@/lib/storage/s3-utils";
import { CopyBlock, appOrigin } from "./store-fields";
import type { ListStep } from "./types";

const STEP_ICONS = {
	ok: <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-green-700" />,
	failed: <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />,
	skipped: <Circle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />,
	advice: <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />,
};

const STEP_STATUS = { ok: "passed", failed: "failed", skipped: "skipped", advice: "advice" };

function checkedText(at: Date | string | null | undefined): string {
	if (!at) return "";
	const date = typeof at === "string" ? new Date(at) : at;
	return ` · Checked ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The checks with ✓/✗, each failure with its fix; a failed browser check carries the CORS rule to copy. When
 * nothing failed, the list folds into one line with Show details; any failure keeps it open.
 */
export function StepList({
	steps,
	checkedAt,
	noun = "checks",
}: {
	steps: ListStep[];
	checkedAt?: Date | string | null;
	/** What the folded line counts: the validation's "checks", or the automatic setup's "steps". */
	noun?: string;
}) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const anyFailed = steps.some((step) => step.status === "failed");
	const expanded = anyFailed || open;
	const corsAt = steps.find((step) => step.id.startsWith("cors_") && step.status === "failed")?.id;
	const passed = steps.filter((step) => step.status === "ok").length;
	const tips = steps.filter((step) => step.status === "advice").length;
	return (
		<div className="space-y-2" data-steps={anyFailed ? "failed" : "passed"}>
			{!anyFailed && (
				<p className="flex flex-wrap items-center gap-x-2 text-sm text-neutral-700">
					<CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-green-700" />
					<span>
						All {passed} {noun} passed
						{tips ? ` · ${tips} ${tips === 1 ? "tip" : "tips"}` : ""}
						{checkedText(checkedAt)}
					</span>
					<button
						type="button"
						aria-expanded={open}
						aria-controls={listId}
						onClick={() => setOpen((value) => !value)}
						className="font-medium text-blue-700 underline-offset-2 hover:underline"
					>
						{open ? "Hide details" : "Show details"}
					</button>
				</p>
			)}
			<ul id={listId} aria-label="Checks" hidden={!expanded} className="space-y-2 text-sm">
				{steps.map((step) => (
					<li key={step.id} data-step={step.id} data-status={step.status} className="flex gap-2">
						{STEP_ICONS[step.status]}
						<div className="min-w-0 flex-1">
							<p className="text-neutral-900">
								{step.label}
								<span className="sr-only">: {STEP_STATUS[step.status]}</span>
							</p>
							{step.detail && <p className="text-neutral-600">{step.detail}</p>}
							{step.fix && <p className="text-neutral-500">{step.fix}</p>}
							{step.id === corsAt && (
								<div className="mt-2" data-cors-rule>
									<CopyBlock label="CORS rule" text={corsRuleJson([appOrigin()])} />
								</div>
							)}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
