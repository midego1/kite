"use client";

import Link from "next/link";
import { Database } from "lucide-react";
import { NOTICE_LINK_CLASS } from "./notice-styles";
import { Notice } from "./ui/notice";
import { dismissMigrationSummary } from "./migration-apply";
import { MigrationApplyButton, MigrationApplyProgress } from "./migration-progress";
import { AppliedNotice } from "./migrations-applied-notice";
import { migrationApplierText, migrationsBannerContent, shouldShowMigrationsBanner } from "./migrations-banner-utils";
import { useMigrationsCardVisible, useMigrationsNotice } from "./use-migrations-notice";

/** The notice's icon while a run is on: the same glyph, pulsing. */
function PulsingDatabase({ className }: { className?: string }) {
	return <Database className={`${className ?? ""} animate-pulse`} aria-hidden="true" />;
}

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
		<Notice
			tone="warning"
			icon={applying ? PulsingDatabase : Database}
			role="region"
			aria-label="Database updates"
			title={content.title}
			className="w-full text-left"
		>
			<p>{content.body}</p>
			{data.names?.length ? <p className="mt-2 break-all text-xs opacity-90">{data.names.join(", ")}</p> : null}
			{showProgress && <MigrationApplyProgress progress={progress} />}
			{summary && <p className="mt-2">{summary}</p>}
			{error && (
				<p role="alert" className="mt-2 text-red-700">
					{error}
				</p>
			)}
			{!isPrimaryAdmin && <p className="mt-2">{migrationApplierText(data.appliedBy)}</p>}
			{isPrimaryAdmin || user.role === "admin" ? (
				<div className="mt-4 flex items-center justify-end gap-3">
					<Link href="/admin" className={`text-xs ${NOTICE_LINK_CLASS}`}>
						Admin overview
					</Link>
					{isPrimaryAdmin && <MigrationApplyButton busy={applying} idleLabel="Apply now" onClick={apply} />}
				</div>
			) : null}
		</Notice>
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
		<Notice
			tone="warning"
			compact
			icon={applying ? PulsingDatabase : Database}
			role="region"
			aria-label="Database updates"
			tooltip={data.names?.join(", ")}
			title={content.title}
		>
			{showProgress ? (
				<MigrationApplyProgress progress={progress} />
			) : (
				<p className={`opacity-90 ${error ? "" : "line-clamp-2"}`}>
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
		</Notice>
	);
}
