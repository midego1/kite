import {
	DIRECT_UPLOADS_REMINDER_TITLE,
	DIRECT_UPLOADS_WHY,
	directUploadsAttemptText,
} from "@/components/storage/direct-uploads-reminder-utils";
import { formatDatabaseBytes } from "@/lib/db/size-utils";
import type { AttentionItem, OverviewData, OverviewStat } from "./overview-types";

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Only the primary admin gets a list entry: for other admins the "Pending database updates" notice under the list
 * already says what waits and who can apply it.
 */
function migrationsItem(data: OverviewData, primary: boolean): AttentionItem | null {
	const pending = data.migrations?.pending ?? 0;
	if (!pending || !primary) return null;
	return {
		id: "migrations",
		tone: "warning",
		title: `${plural(pending, "database update")} waiting`,
		detail: "Until they are applied, new email may not appear and some pages may fail.",
		href: "#database",
		hrefLabel: "Update database",
	};
}

function backupItems(backups: OverviewData["backups"]): AttentionItem[] {
	if (!backups) return [];
	const items: AttentionItem[] = [];
	if (backups.restore?.needsRecovery)
		items.push({
			id: "restore",
			tone: "error",
			title: "A restore failed and could not be rolled back",
			detail: "The data from before the restore is kept in a safety backup.",
			href: "#backups",
			hrefLabel: "Restore previous data",
		});
	if (backups.lastFailure)
		items.push({
			id: "backup-failed",
			tone: "error",
			title: "The last backup failed",
			detail: backups.lastFailure.error ?? undefined,
			href: "/backups",
			hrefLabel: "Open Backups",
		});
	else if (!backups.lastSuccess && !backups.inProgress)
		items.push({
			id: "backup-none",
			tone: "warning",
			title: "No successful backup yet",
			detail: backups.automatic?.enabled
				? "The first automatic backup runs at 02:00 UTC. Run one now to be safe."
				: "Automatic backups are off.",
			href: "/backups",
			hrefLabel: "Open Backups",
		});
	return items;
}

function databaseItem(databaseSize: OverviewData["databaseSize"]): AttentionItem | null {
	if (!databaseSize?.size || databaseSize.level === "ok") return null;
	const { size, level } = databaseSize;
	const percent = size.limitBytes ? Math.round((size.usedBytes / size.limitBytes) * 100) : 0;
	return {
		id: "database-size",
		tone: level === "critical" ? "error" : "warning",
		title: `The database is at ${percent}% of its size limit`,
		detail:
			level === "critical"
				? "Running imports pause and new ones ask for confirmation. Delete mail you do not need, or move to a plan with a larger limit."
				: "Large imports will warn before they start.",
		href: "#database-size",
		hrefLabel: "Details",
	};
}

function webhooksItem(counts: OverviewData["counts"]): AttentionItem | null {
	const webhooks = counts?.webhooks;
	if (!webhooks?.failingHooks) return null;
	return {
		id: "webhooks",
		tone: "warning",
		title: `${plural(webhooks.failingHooks, "webhook")} with failed deliveries`,
		detail: `${plural(webhooks.recentFailures, "delivery", "deliveries")} could not be made in the last 24 hours.`,
		href: "/webhooks",
		hrefLabel: "Open Webhooks",
	};
}

function aiErrorsItem(counts: OverviewData["counts"]): AttentionItem | null {
	const errors = counts?.aiErrors;
	if (!errors?.recent) return null;
	const number = errors.capped ? `${errors.recent}+` : String(errors.recent);
	return {
		id: "ai-errors",
		tone: "warning",
		title: `${number} AI ${errors.recent === 1 && !errors.capped ? "request" : "requests"} failed in the last 24 hours`,
		href: "/agent",
		hrefLabel: "Open Agent",
	};
}

/** Only shown to someone who can open Domains: the primary admin or an admin with the domain grant. */
function domainsItem(counts: OverviewData["counts"]): AttentionItem | null {
	const domains = counts?.domains;
	if (!domains?.inactive) return null;
	return {
		id: "domains",
		tone: "info",
		title: `${plural(domains.inactive, "domain")} not active yet`,
		detail: "Finish its DNS setup so mail can arrive.",
		href: "/domains",
		hrefLabel: "Open Domains",
	};
}

/**
 * Direct uploads are the default on Cloudflare: until they are on (or the owner dismissed it), the primary admin is
 * reminded, as a warning when the automatic setup ran and failed. Dismiss hides it on the Storage page too.
 */
function directUploadsItem(data: OverviewData, primary: boolean): AttentionItem | null {
	const reminder = data.directUploads;
	if (!primary || !reminder?.show) return null;
	const attempt = directUploadsAttemptText(reminder.setup);
	return {
		id: "direct-uploads",
		tone: attempt ? "warning" : "info",
		title: DIRECT_UPLOADS_REMINDER_TITLE,
		detail: attempt ?? DIRECT_UPLOADS_WHY,
		href: "/storage?setup=direct",
		hrefLabel: "Set up",
		dismissible: true,
	};
}

/** What needs attention, most urgent first: errors, then warnings, then information. */
export function attentionItems(data: OverviewData, primary: boolean): AttentionItem[] {
	const items = [
		migrationsItem(data, primary),
		...backupItems(data.backups),
		databaseItem(data.databaseSize),
		webhooksItem(data.counts),
		aiErrorsItem(data.counts),
		domainsItem(data.counts),
		directUploadsItem(data, primary),
	].filter((item): item is AttentionItem => item !== null);
	const rank = { error: 0, warning: 1, info: 2 };
	return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** The headline counts; a part the viewer could not read is left out rather than shown as zero. */
export function overviewStats(data: OverviewData): OverviewStat[] {
	const stats: OverviewStat[] = [];
	const { counts } = data;
	if (counts) {
		const { accounts, mailboxes, domains } = counts;
		stats.push({
			id: "accounts",
			label: "Accounts",
			value: String(accounts.total),
			hint: [plural(accounts.admins, "admin"), accounts.disabled ? plural(accounts.disabled, "disabled") : ""]
				.filter(Boolean)
				.join(" · "),
			href: "/accounts",
		});
		stats.push({
			id: "mailboxes",
			label: "Mailboxes",
			value: String(mailboxes.total),
			hint: mailboxes.shared ? plural(mailboxes.shared, "shared inbox", "shared inboxes") : "No shared inboxes",
			href: "/mailboxes",
		});
		if (domains)
			stats.push({
				id: "domains",
				label: "Domains",
				value: String(domains.total),
				hint: domains.inactive ? `${domains.active} of ${domains.total} active` : "All active",
				href: "/domains",
			});
	}
	if (data.databaseSize?.size) {
		const { size, level } = data.databaseSize;
		const percent = size.limitBytes ? Math.round((size.usedBytes / size.limitBytes) * 100) : null;
		stats.push({
			id: "database",
			label: "Database",
			value: formatDatabaseBytes(size.usedBytes),
			hint:
				percent === null
					? "No size limit on this server"
					: `${percent}% of ${formatDatabaseBytes(size.limitBytes ?? 0)}`,
			href: "#database-size",
			tone: level === "ok" ? "neutral" : level === "warn" ? "warning" : "critical",
		});
	}
	return stats;
}
