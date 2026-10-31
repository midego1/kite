import type { ExternalAccountView } from "@/lib/external-accounts/types";
import type { OverviewData } from "@/app/(admin)/admin/overview-types";
import type { AccountLine, AccountLinesInput, HealthLine, StatusChip, StatusChipsInput } from "./command-center-types";

/** How many connected accounts the card lists before pointing at Settings. */
export const MAX_ACCOUNT_LINES = 4;

/** The greeting for an hour of the day in the user's time zone. */
export function greetingFor(hour: number): string {
	if (hour < 5) return "Good night";
	if (hour < 12) return "Good morning";
	if (hour < 18) return "Good afternoon";
	return "Good evening";
}

/** The hour of `now` in `timeZone`; the device's hour when the zone is unknown to the runtime. */
export function hourIn(now: Date, timeZone: string): number {
	try {
		const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now);
		const parsed = Number.parseInt(hour, 10);
		return Number.isFinite(parsed) ? parsed : now.getHours();
	} catch {
		return now.getHours();
	}
}

/** "Saturday 31 October 2026", in the user's time zone and the browser's language; the same shape in every runtime. */
export function dateLabel(now: Date, timeZone: string, locale?: string): string {
	try {
		const parts = new Intl.DateTimeFormat(locale, {
			weekday: "long",
			day: "numeric",
			month: "long",
			year: "numeric",
			timeZone,
		}).formatToParts(now);
		const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
		return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
	} catch {
		return now.toDateString();
	}
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * The counts above the cards. Unread is always there (also at zero, so the line never jumps); the Screener chip
 * only while the mailbox screens new senders or still holds mail, as its sidebar item; For you only once its
 * count is known and some mailbox reads mail automatically.
 */
export function statusChips(input: StatusChipsInput): StatusChip[] {
	const chips: StatusChip[] = [
		{
			id: "unread",
			label: `${input.unread} unread in ${input.folderTitle}`,
			href: "/inbox",
			tone: "blue",
		},
	];
	if (input.screenerOn || input.held > 0)
		chips.push({ id: "screener", label: `${input.held} in Screener`, href: "/screener", tone: "amber" });
	if (input.forYouVisible && input.forYou !== null)
		chips.push({ id: "for-you", label: `${input.forYou} For you`, href: "/for-you", tone: "violet" });
	return chips;
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "5 days ago"; empty for nothing or a date in the future. */
export function relativeTime(iso: string | null | undefined, now: Date): string {
	if (!iso) return "";
	const at = new Date(iso).getTime();
	if (!Number.isFinite(at)) return "";
	const seconds = Math.round((now.getTime() - at) / 1000);
	if (seconds < 0) return "";
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

const CONNECTED_ACCOUNTS_HREF = "/settings/connected-accounts";

function accountLine(account: ExternalAccountView, now: Date): AccountLine {
	const base = { id: account.id, name: account.label || account.address, address: account.address };
	const review = { label: "Review", href: CONNECTED_ACCOUNTS_HREF };
	switch (account.status) {
		case "auth_failed":
			return {
				...base,
				tone: "warn",
				detail: "Sign-in failed",
				action: { label: "Reconnect", href: CONNECTED_ACCOUNTS_HREF },
			};
		case "tls_failed":
			return { ...base, tone: "warn", detail: "Certificate problem", action: review };
		case "error":
			return { ...base, tone: "warn", detail: "Checking stopped", action: review };
		case "paused":
			return { ...base, tone: "muted", detail: "Paused", action: null };
		case "disabled":
			return { ...base, tone: "muted", detail: "Off", action: null };
		default: {
			if (account.sync.running) return { ...base, tone: "ok", detail: "Checking now", action: null };
			const since = relativeTime(account.sync.lastSuccessAt, now);
			return { ...base, tone: "ok", detail: since ? `Synced ${since}` : "Not checked yet", action: null };
		}
	}
}

/** Accounts that need the owner first, then the rest in their order, at most MAX_ACCOUNT_LINES. */
export function accountLines({ accounts, now }: AccountLinesInput): AccountLine[] {
	const lines = accounts.map((account) => accountLine(account, now));
	const rank = (line: AccountLine) => (line.tone === "warn" ? 0 : line.tone === "ok" ? 1 : 2);
	return lines.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ACCOUNT_LINES);
}

/** The admin page's anchors (`#database`) open the admin overview from the mailbox. */
export function attentionHref(href: string): string {
	return href.startsWith("#") ? `/admin${href}` : href;
}

/** Megabytes with one decimal below a gigabyte, gigabytes above. */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * What is fine, for the primary admin: the last backup that worked (only while nothing about backups is wrong)
 * and the database's size within its limit (only while it is comfortably within it). Nothing is said about parts
 * that were not read.
 */
export function healthLines(data: OverviewData, now: Date): HealthLine[] {
	const lines: HealthLine[] = [];
	const backups = data.backups;
	if (backups && backups.level === "ok" && backups.lastSuccess && !backups.restore?.needsRecovery) {
		const when = relativeTime(backups.lastSuccess.completedAt, now);
		lines.push({
			id: "backups",
			text: `Backups healthy · last backup ${when || "finished"}`,
			detail: backups.lastSuccess.size ? formatBytes(backups.lastSuccess.size) : "",
		});
	}
	const size = data.databaseSize;
	if (size?.size && size.level === "ok") {
		const { usedBytes, limitBytes } = size.size;
		lines.push({
			id: "database",
			text: limitBytes
				? `Database ${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}`
				: `Database ${formatBytes(usedBytes)}`,
			detail: limitBytes ? `${Math.round((usedBytes / limitBytes) * 100)}%` : "",
		});
	}
	return lines;
}
