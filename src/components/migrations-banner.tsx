"use client";

import Link from "next/link";
import { Database } from "lucide-react";
import { NOTICE_LINK_CLASS, WARNING_NOTICE_CLASS, WARNING_TONE_CLASS } from "./notice-styles";
import { dismissMigrationSummary } from "./migration-apply";
import { MigrationApplyButton, MigrationApplyProgress } from "./migration-progress";
import { AppliedNotice } from "./migrations-applied-notice";
import { migrationApplierText, migrationsBannerContent, shouldShowMigrationsBanner } from "./migrations-banner-utils";
import { useMigrationsCardVisible, useMigrationsNotice } from "./use-migrations-notice";

/**
 * The full notice, shown in the empty reading pane: a deployed version runs before
 * its migrations are applied, and until then new mail cannot be stored.
 */
export function MigrationsNoticeCard() {
	const { user, isPrimaryAdmin, data, progress, applying, showProgress, summary, error, apply } = useMigrationsNotice();
	if (!user) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		// Everything applied: the result of the run stays a few seconds, then leaves (migrations-applied-notice.tsx).
		return summary ? (
			<AppliedNotice summary={summary} onDismiss={dismissMigrationSummary} className="w-full text-left" />
		) : null;
	}
	const content = migrationsBannerContent(data.pending);

	return (
		<section
			aria-label="Database updates"
			className={`w-full rounded-xl border p-5 text-left text-sm ${WARNING_TONE_CLASS}`}
		>
			<div className="flex items-start gap-3">
				<Database className={`mt-0.5 h-5 w-5 shrink-0 ${applying ? "animate-pulse" : ""}`} aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">{content.title}</p>
					<p className="mt-1">{content.body}</p>
					{data.names?.length ? <p className="mt-2 break-all text-xs opacity-90">{data.names.join(", ")}</p> : null}
					{showProgress && <MigrationApplyProgress progress={progress} />}
					{summary && <p className="mt-2">{summary}</p>}
					{error && (
						<p role="alert" className="mt-2 text-red-700">
							{error}
						</p>
					)}
					{!isPrimaryAdmin && <p className="mt-2">{migrationApplierText(data.appliedBy)}</p>}
				</div>
			</div>
			{isPrimaryAdmin || user.role === "admin" ? (
				<div className="mt-4 flex items-center justify-end gap-3">
					<Link href="/admin" className="text-xs underline underline-offset-2 hover:opacity-80">
						Admin overview
					</Link>
					{isPrimaryAdmin && <MigrationApplyButton busy={applying} idleLabel="Apply now" onClick={apply} />}
				</div>
			) : null}
		</section>
	);
}

/** One line above the mailbox, for whenever the empty reading pane (and its card) is not on screen. */
export function MigrationsBanner() {
	const { user, isPrimaryAdmin, data, progress, applying, showProgress, summary, error, apply } = useMigrationsNotice();
	const cardVisible = useMigrationsCardVisible();
	if (!user || cardVisible) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		return summary ? <AppliedNotice summary={summary} onDismiss={dismissMigrationSummary} compact /> : null;
	}
	const content = migrationsBannerContent(data.pending);

	return (
		<section aria-label="Database updates" title={data.names?.join(", ")} className={WARNING_NOTICE_CLASS}>
			<Database className={`mt-px h-3.5 w-3.5 shrink-0 ${applying ? "animate-pulse" : ""}`} aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{content.title}</p>
				{showProgress ? (
					<MigrationApplyProgress progress={progress} />
				) : (
					<p className={`mt-0.5 opacity-90 ${error ? "" : "line-clamp-2"}`}>
						{error ? (
							<span role="alert" className="text-red-600 dark:text-red-400">
								{error}
							</span>
						) : isPrimaryAdmin ? (
							content.body
						) : (
							migrationApplierText(data.appliedBy)
						)}
					</p>
				)}
				{isPrimaryAdmin ? (
					<MigrationApplyButton
						busy={applying}
						idleLabel="Apply now"
						onClick={apply}
						className="mt-1.5 h-7 px-2 text-xs"
					/>
				) : user.role === "admin" ? (
					<Link href="/admin" className={`mt-1 inline-block ${NOTICE_LINK_CLASS}`}>
						Admin overview
					</Link>
				) : null}
			</div>
		</section>
	);
}
