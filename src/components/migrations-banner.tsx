"use client";

import { dismissMigrationSummary } from "./migration-apply";
import { MigrationNoticeCard } from "./migration-notice-card";
import { AppliedNotice } from "./migrations-applied-notice";
import { shouldShowMigrationsBanner } from "./migrations-banner-utils";
import { useMigrationsCardVisible, useMigrationsNotice } from "./use-migrations-notice";

/**
 * The full notice, shown in the empty reading pane: a deployed version runs before
 * its migrations are applied, and until then new mail cannot be stored.
 */
export function MigrationsNoticeCard() {
	const notice = useMigrationsNotice();
	const { user, data, summary } = notice;
	if (!user) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		// Everything applied: the result of the run stays a few seconds, then leaves (migrations-applied-notice.tsx).
		return summary ? (
			<AppliedNotice summary={summary} onDismiss={dismissMigrationSummary} className="w-full text-start" />
		) : null;
	}
	return <MigrationNoticeCard notice={notice} className="w-full text-start" />;
}

/** One card above the mailbox, for whenever the empty reading pane (and its card) is not on screen. */
export function MigrationsBanner() {
	const notice = useMigrationsNotice();
	const cardVisible = useMigrationsCardVisible();
	const { user, data, summary } = notice;
	if (!user || cardVisible) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		return summary ? <AppliedNotice summary={summary} onDismiss={dismissMigrationSummary} compact /> : null;
	}
	return <MigrationNoticeCard notice={notice} compact />;
}
