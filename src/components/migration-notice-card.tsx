"use client";

import Link from "next/link";
import { CircleX, Database, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { noticeClass } from "@/components/ui/notice-utils";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { useElapsedSeconds } from "./migration-apply";
import {
	migrationDetailLabels,
	migrationNoticePhase,
	migrationNoticeState,
	migrationProgressPercent,
} from "./migration-notice-utils";
import { formatElapsed, migrationProgressView } from "./migration-progress-utils";
import { migrationApplierWho } from "./migrations-banner-utils";
import type { PendingMigrationsResponse } from "./migrations-banner-types";
import type { useMigrationsNotice } from "./use-migrations-notice";

type MigrationsNotice = ReturnType<typeof useMigrationsNotice>;

interface MigrationNoticeCardProps {
	notice: MigrationsNotice;
	/** The sidebar size; the page size is for the empty reading pane. */
	compact?: boolean;
	className?: string;
}

/** What is waiting and why it matters, one tap away from the card; the file names are turned into words. */
function DetailsDialog({ data }: { data: PendingMigrationsResponse }) {
	const t = useT();
	const labels = migrationDetailLabels(data.names);
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs hover:bg-current/10">
					{t("Details")}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("Waiting database updates")}</DialogTitle>
					<DialogDescription>
						{t("Kite was updated, but these changes to the database have not been applied yet.")}{" "}
						{t("Until they are applied, new email may not appear and some pages may fail.")}
					</DialogDescription>
				</DialogHeader>
				{labels.length > 0 && (
					<ul className="list-disc space-y-1 ps-5 text-sm text-neutral-800 [overflow-wrap:anywhere]">
						{labels.map((label) => (
							<li key={label}>{label}</li>
						))}
					</ul>
				)}
				<p className="mt-4 text-sm text-neutral-500">
					{t("Before applying them, Kite saves a safety backup of the database when there is data to save.")}
				</p>
			</DialogContent>
		</Dialog>
	);
}

/** The thin line along the card's lower edge: it takes no room, so the card never changes height when a run starts. */
function ProgressLine({ done, total, label }: { done: number; total: number; label: string }) {
	const percent = migrationProgressPercent(done, total);
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={percent === null ? undefined : total}
			aria-valuenow={percent === null ? undefined : done}
			className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-current/15"
		>
			<div
				className={cn(
					"h-full bg-current/60",
					percent === null ? "w-full motion-safe:animate-pulse" : "transition-[width] motion-reduce:transition-none",
				)}
				style={percent === null ? undefined : { width: `${percent}%` }}
			/>
		</div>
	);
}

/**
 * The database update notice, in one shape for the sidebar, the strip over the page and the empty reading pane:
 * an icon and a one-line title, a status line, and one button. It never scrolls and never cuts a word off; text
 * wraps, and what does not fit a line (the updates in words, the primary admin's address) sits in the details dialog
 * or wraps. A run shows as a thin line along the lower edge, so starting one moves nothing.
 */
export function MigrationNoticeCard({ notice, compact = false, className }: MigrationNoticeCardProps) {
	const t = useT();
	const { user, isPrimaryAdmin, data, progress, applying, showProgress, error, apply } = notice;
	const elapsed = useElapsedSeconds(showProgress ? progress.startedAt : null);
	if (!user || !data) return null;

	const state = migrationNoticeState({ busy: applying, error });
	const view = migrationProgressView(progress.startNames, progress.remaining, progress.recovering);
	const phase = migrationNoticePhase(view, showProgress);
	const isAdmin = user.role === "admin";
	const who = migrationApplierWho(data.appliedBy);

	const title = { pending: t("Database update"), applying: t("Updating database…"), failed: t("Update failed") }[state];
	const Icon = state === "failed" ? CircleX : Database;
	const status = {
		backup: t("Saving a backup…"),
		applying: t("Applying {done} of {total}…", { done: view.done, total: view.total }),
		recovering: t("Connection lost, checking…"),
		elsewhere: t("Update in progress…"),
	}[phase];

	return (
		<section
			role="region"
			aria-label={t("Database updates")}
			data-testid="migration-notice"
			data-state={state}
			className={cn(
				"relative flex min-w-0 flex-col overflow-hidden [overflow-wrap:anywhere]",
				compact ? "gap-1.5" : "gap-2",
				noticeClass(state === "failed" ? "error" : "warning", compact),
				className,
			)}
		>
			<div className="flex items-center gap-2">
				<Icon
					className={cn(
						"shrink-0",
						compact ? "h-3.5 w-3.5" : "h-4 w-4",
						state === "applying" && "motion-safe:animate-pulse",
					)}
					aria-hidden="true"
				/>
				<p className="min-w-0 flex-1 font-medium">{title}</p>
			</div>

			{state === "applying" && (
				<>
					{/* What a screen reader hears changes with the step, never with the clock. */}
					<p className="sr-only" role="status" aria-live="polite">
						{view.announcement}
					</p>
					<div className="flex items-baseline justify-between gap-2">
						<p>{status}</p>
						{showProgress && (
							<p className="shrink-0 tabular-nums opacity-80" aria-hidden="true">
								{formatElapsed(elapsed)}
							</p>
						)}
					</div>
					<p className="opacity-80">{t("Keep this page open.")}</p>
					<ProgressLine done={view.done} total={view.total} label={t("Database update progress")} />
				</>
			)}

			{state === "failed" && (
				<p role="alert" data-testid="migration-error">
					{error}
				</p>
			)}

			{state === "pending" && (
				<>
					<p>{t("{count, plural, one {# update waiting} other {# updates waiting}}", { count: data.pending })}</p>
					{!compact && (
						<p className="opacity-90">
							{t("Until they are applied, new email may not appear and some pages may fail.")}
						</p>
					)}
					<p className="opacity-80">
						{isPrimaryAdmin
							? t("A safety backup is saved first.")
							: who
								? t("Only the primary admin, {who}, can apply them.", { who })
								: t("Ask an administrator to apply them.")}
					</p>
				</>
			)}

			<div className="flex flex-wrap items-center gap-1.5">
				{isPrimaryAdmin ? (
					<MigrationNoticeButton
						busy={state === "applying"}
						label={state === "failed" ? t("Retry") : t("Update now")}
						busyLabel={t("Updating…")}
						onClick={apply}
					/>
				) : isAdmin ? (
					<AdminLink label={t("Admin overview")} />
				) : null}
				{state === "failed" && isPrimaryAdmin && <AdminLink label={t("Admin overview")} />}
				{state !== "failed" && <DetailsDialog data={data} />}
			</div>
		</section>
	);
}

function MigrationNoticeButton({
	busy,
	label,
	busyLabel,
	onClick,
}: {
	busy: boolean;
	label: string;
	busyLabel: string;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			size="sm"
			onClick={onClick}
			disabled={busy}
			aria-busy={busy}
			className="h-7 flex-auto px-2 text-xs"
		>
			{busy && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
			{busy ? busyLabel : label}
		</Button>
	);
}

function AdminLink({ label }: { label: string }) {
	return (
		<Link
			href="/admin"
			className="inline-flex h-7 shrink-0 items-center rounded-lg px-2 text-xs underline underline-offset-2 hover:bg-current/10"
		>
			{label}
		</Link>
	);
}
