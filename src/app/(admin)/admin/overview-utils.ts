import { formatDatabaseBytes } from "@/lib/db/size-utils";
import type { AttentionItem, OverviewData, OverviewStat } from "./overview-types";

/** AI failures older than this are history, not something to act on. */
const RECENT_AI_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

function migrationsItem(data: OverviewData, primary: boolean): AttentionItem | null {
	const pending = data.migrations?.pending ?? 0;
	if (!pending) return null;
	return {
		id: "migrations",
		tone: "warning",
		title: `${plural(pending, "database update")} waiting`,
		detail: primary
			? "Until they are applied, new email may not appear and some pages may fail."
			: "Only the primary admin can apply them. Until then new email may not appear and some pages may fail.",
		href: primary ? "#database" : "/admin",
		hrefLabel: primary ? "Update database" : "",
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

function webhooksItem(webhooks: OverviewData["webhooks"]): AttentionItem | null {
	const failing = (webhooks ?? []).filter((hook) => hook.enabled && hook.stats.failing > 0);
	if (!failing.length) return null;
	const deliveries = failing.reduce((sum, hook) => sum + hook.stats.failing, 0);
	return {
		id: "webhooks",
		tone: "warning",
		title: `${plural(failing.length, "webhook")} with failed deliveries`,
		detail: `${plural(deliveries, "delivery", "deliveries")} could not be made.`,
		href: "/webhooks",
		hrefLabel: "Open Webhooks",
	};
}

function aiErrorsItem(aiErrors: OverviewData["aiErrors"], now: number): AttentionItem | null {
	const recent = (aiErrors ?? []).filter((row) => {
		const at = Date.parse(row.at);
		return Number.isFinite(at) && now - at <= RECENT_AI_ERROR_WINDOW_MS;
	});
	if (!recent.length) return null;
	return {
		id: "ai-errors",
		tone: "warning",
		title: `${plural(recent.length, "AI request")} failed in the last 24 hours`,
		href: "/agent",
		hrefLabel: "Open Agent",
	};
}

function domainsItem(domains: OverviewData["domains"]): AttentionItem | null {
	const inactive = (domains ?? []).filter((domain) => domain.status !== "active" && !domain.dnsSkipped);
	if (!inactive.length) return null;
	return {
		id: "domains",
		tone: "info",
		title: `${plural(inactive.length, "domain")} not active yet`,
		detail: "Finish its DNS setup so mail can arrive.",
		href: "/domains",
		hrefLabel: "Open Domains",
	};
}

/** What needs attention, most urgent first: errors, then warnings, then information. */
export function attentionItems(data: OverviewData, primary: boolean, now = Date.now()): AttentionItem[] {
	const items = [
		migrationsItem(data, primary),
		...backupItems(data.backups),
		databaseItem(data.databaseSize),
		webhooksItem(data.webhooks),
		aiErrorsItem(data.aiErrors, now),
		domainsItem(data.domains),
	].filter((item): item is AttentionItem => item !== null);
	const rank = { error: 0, warning: 1, info: 2 };
	return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** The headline counts; a part the viewer could not read is left out rather than shown as zero. */
export function overviewStats(data: OverviewData, versionLabel: string): OverviewStat[] {
	const stats: OverviewStat[] = [];
	if (data.accounts) {
		const admins = data.accounts.filter((account) => account.role === "admin").length;
		const disabled = data.accounts.filter((account) => account.disabled).length;
		stats.push({
			id: "accounts",
			label: "Accounts",
			value: String(data.accounts.length),
			hint: [plural(admins, "admin"), disabled ? plural(disabled, "disabled") : ""].filter(Boolean).join(" · "),
			href: "/accounts",
		});
	}
	if (data.mailboxes) {
		const shared = data.mailboxes.filter((mailbox) => mailbox.type === "shared").length;
		stats.push({
			id: "mailboxes",
			label: "Mailboxes",
			value: String(data.mailboxes.length),
			hint: shared ? plural(shared, "shared inbox", "shared inboxes") : "No shared inboxes",
			href: "/mailboxes",
		});
	}
	if (data.domains) {
		const active = data.domains.filter((domain) => domain.status === "active").length;
		stats.push({
			id: "domains",
			label: "Domains",
			value: String(data.domains.length),
			hint: data.domains.length === active ? "All active" : `${active} of ${data.domains.length} active`,
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
			hint: percent === null ? `Kite v${versionLabel}` : `${percent}% of ${formatDatabaseBytes(size.limitBytes ?? 0)}`,
			href: "#database",
			tone: level === "ok" ? "neutral" : level === "warn" ? "warning" : "critical",
		});
	}
	return stats;
}
