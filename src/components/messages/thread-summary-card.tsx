"use client";

import { useState } from "react";
import clsx from "clsx";
import { Copy, Languages, RefreshCw, Sparkles, X } from "lucide-react";
import { AiErrorNotice } from "@/components/agent/ai-error-notice";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { SummaryPoint, SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";
import type { ThreadSummaryController } from "./thread-summary-types";
import { canSummarize, summaryCopyText, translateLabel } from "./thread-summary-utils";
import { MAILBOX_AI_OFF_TEXT } from "@/lib/agent/mailbox-ai-utils";
import { useT } from "@/lib/i18n/use-t";
import { t } from "@/lib/i18n/translator";

/** The reader toolbar's Summarize button, shown only where a summary can be made. */
export function SummarizeButton({ controller }: { controller: ThreadSummaryController }) {
	const t = useT();
	// No AI for this mailbox: the button stays where people look for it and says why it does nothing.
	if (controller.state?.reason === "mailbox_ai_off")
		return (
			<Tooltip label={t(MAILBOX_AI_OFF_TEXT)}>
				<Button
					variant="ghost"
					size="sm"
					aria-label={t("Summarize: {reason}", { reason: t(MAILBOX_AI_OFF_TEXT) })}
					aria-disabled="true"
					data-testid="summarize-ai-off"
					className="cursor-not-allowed gap-1.5 text-neutral-400 hover:bg-transparent"
				>
					<Sparkles aria-hidden className="h-4 w-4" />
					<span className="hidden sm:inline">{t("Summarize")}</span>
				</Button>
			</Tooltip>
		);
	if (!canSummarize(controller.state)) return null;
	const label = controller.scope === "thread" ? t("Summarize conversation") : t("Summarize message");
	const tooltip = controller.blocked ?? label;
	return (
		<Tooltip label={tooltip}>
			<Button
				variant="ghost"
				size="sm"
				aria-label={label}
				disabled={controller.busy !== null || !!controller.blocked}
				onClick={() => controller.summarize()}
				className="gap-1.5 text-neutral-700"
			>
				<Sparkles aria-hidden className="h-4 w-4" />
				<span className="hidden sm:inline">{controller.busy === "summarize" ? t("Summarizing…") : t("Summarize")}</span>
			</Button>
		</Tooltip>
	);
}

function Points({ points }: { points: SummaryPoint[] }) {
	if (!points.length) return null;
	return (
		<ul className="mt-2 space-y-1">
			{points.map((point, index) => (
				<li key={`${point.label}-${index}`} className="flex gap-2">
					<span className="w-24 shrink-0 font-medium text-neutral-900">{point.label}</span>
					<span dir="auto" className="min-w-0">
						{point.text}
					</span>
				</li>
			))}
		</ul>
	);
}

type Shown = Pick<NonNullable<SummaryState["summary"]>, "overview" | "points">;

function StaleNotice({ controller }: { controller: ThreadSummaryController }) {
	const t = useT();
	const { busy, state } = controller;
	const summary = state?.summary;
	if (!summary?.stale) return null;
	return (
		<div className="mb-2 flex flex-wrap items-center gap-2">
			<p className="text-neutral-700">{t("New messages since this summary")}</p>
			<Button
				size="sm"
				variant="outline"
				disabled={busy !== null || !!controller.blocked || !state?.eligible}
				onClick={() => controller.summarize(summary.scope)}
				className="gap-1.5"
			>
				<RefreshCw aria-hidden className={clsx("h-3.5 w-3.5", busy === "summarize" && "animate-spin")} />
				{busy === "summarize" ? t("Summarizing…") : t("Summarize again")}
			</Button>
		</div>
	);
}

const LINK = "inline-flex items-center gap-1 font-medium text-blue-700 hover:text-blue-900 disabled:text-neutral-400";

function TranslationToggle({
	controller,
	original,
	onToggle,
}: {
	controller: ThreadSummaryController;
	original: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const { state, busy, language } = controller;
	if (state?.translation)
		return (
			<button type="button" onClick={onToggle} className={LINK}>
				<Languages aria-hidden className="h-3.5 w-3.5" />
				{original ? t("Show translation") : t("Show original")}
			</button>
		);
	if (!state?.translatable || state.summary?.stale || !language) return null;
	return (
		<button
			type="button"
			disabled={busy !== null || !!controller.blocked}
			onClick={controller.translate}
			className={LINK}
		>
			<Languages aria-hidden className="h-3.5 w-3.5" />
			{busy === "translate" ? t("Translating…") : translateLabel(language)}
		</button>
	);
}

function Footnote({
	controller,
	shown,
	original,
	onToggle,
}: {
	controller: ThreadSummaryController;
	shown: Shown;
	original: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const model = controller.state?.summary?.model;
	const copy = () => void navigator.clipboard?.writeText(summaryCopyText(shown)).then(() => setCopied(true));
	return (
		<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
			<span className="flex-1">
				{model ? t("Written by AI ({model}), may be wrong", { model }) : t("Written by AI, may be wrong")}
			</span>
			<TranslationToggle controller={controller} original={original} onToggle={onToggle} />
			<button type="button" onClick={copy} className={LINK}>
				<Copy aria-hidden className="h-3.5 w-3.5" />
				{copied ? t("Copied") : t("Copy")}
			</button>
		</div>
	);
}

function heading(scope: SummaryScope | undefined): string {
	if (!scope) return t("AI Summary");
	return scope === "thread" ? t("AI Summary of this conversation") : t("AI Summary of this message");
}

/**
 * The summary card at the top of the reader, in the style of the automatic-reading "AI Summary" box: the
 * overview and its points, greyed with Summarize again when the conversation changed since, the translation
 * into the reader's language on demand, and a footnote naming the model with Copy and Hide.
 */
export function ThreadSummaryCard({ controller }: { controller: ThreadSummaryController }) {
	const t = useT();
	const [original, setOriginal] = useState(false);
	const { state, busy, error, hidden } = controller;
	const summary = state?.summary ?? null;
	if (hidden || (!summary && !error && busy !== "summarize")) return null;
	const shown: Shown | null = (!original && state?.translation) || summary;
	return (
		<div className="px-4 pb-5 sm:px-7">
			<section
				aria-label={t("AI summary")}
				data-thread-summary
				data-stale={summary?.stale ? "true" : undefined}
				className="rounded-xl border border-indigo-400/60 bg-indigo-500/[0.04] p-4 text-sm"
			>
				<div className="mb-2 flex items-center gap-1.5 text-sm text-neutral-500">
					<Sparkles aria-hidden className="h-3.5 w-3.5" />
					<span className="flex-1">{heading(summary?.scope)}</span>
					<Tooltip label={t("Hide summary")}>
						<button
							type="button"
							aria-label={t("Hide summary")}
							onClick={controller.hide}
							className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
						>
							<X aria-hidden className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
				</div>
				{!summary && busy === "summarize" && <p className="text-neutral-500">{t("Summarizing…")}</p>}
				<StaleNotice controller={controller} />
				{shown && (
					<div data-summary-body className={`reading-font ${summary?.stale ? "text-neutral-500" : "text-neutral-800"}`}>
						<p dir="auto" className="whitespace-pre-line">
							{shown.overview}
						</p>
						<Points points={shown.points} />
					</div>
				)}
				{error && (
					<AiErrorNotice className="mt-2" message={error} error={controller.failure} onRetry={controller.retry} />
				)}
				{shown && (
					<Footnote controller={controller} shown={shown} original={original} onToggle={() => setOriginal(!original)} />
				)}
			</section>
		</div>
	);
}
