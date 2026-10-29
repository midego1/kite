import { authFetch } from "@/lib/auth/client";
import type { ExternalAccountStatus, ExternalAccountView } from "@/lib/external-accounts/types";
import type { AccountFormState, ConnectedAccountsState, PresetOption } from "./connected-accounts-types";

export const CONNECTED_ACCOUNTS_QUERY_KEY = ["external-accounts"];

async function readJson<T>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? fallback);
	return data;
}

export async function fetchConnectedAccounts(): Promise<ConnectedAccountsState> {
	const response = await authFetch("/api/external-accounts", { cache: "no-store" });
	return readJson<ConnectedAccountsState>(response, "Could not load connected accounts");
}

/** The provider an address most likely belongs to; `other` when the lookup fails. */
export async function detectProvider(address: string): Promise<PresetOption["id"]> {
	const response = await authFetch(`/api/external-accounts/detect?address=${encodeURIComponent(address)}`);
	if (!response.ok) return "other";
	const data = (await response.json().catch(() => ({}))) as { preset?: PresetOption["id"] };
	return data.preset ?? "other";
}

export function emptyAccountForm(mailboxId: string): AccountFormState {
	return {
		address: "",
		preset: "other",
		label: "",
		mailboxId,
		username: "",
		password: "",
		kitePassword: "",
		imapHost: "",
		imapPort: "993",
		imapSecurity: "tls",
		smtpHost: "",
		smtpPort: "465",
		smtpSecurity: "tls",
		syncIntervalMinutes: "5",
	};
}

export function accountForm(account: ExternalAccountView): AccountFormState {
	return {
		address: account.address,
		preset: account.preset,
		label: account.label === account.address ? "" : account.label,
		mailboxId: account.mailboxId,
		username: account.username === account.address ? "" : account.username,
		password: "",
		kitePassword: "",
		imapHost: account.imap.host,
		imapPort: String(account.imap.port),
		imapSecurity: account.imap.security,
		smtpHost: account.smtp?.host ?? "",
		smtpPort: String(account.smtp?.port ?? 465),
		smtpSecurity: account.smtp?.security ?? "tls",
		syncIntervalMinutes: String(account.sync.intervalMinutes),
	};
}

/** The request body of a connect or edit; servers are sent only for "Other", whose servers the user enters. */
function accountRequestBody(form: AccountFormState) {
	const custom = form.preset === "other";
	return {
		address: form.address.trim(),
		preset: form.preset,
		label: form.label.trim() || form.address.trim(),
		mailboxId: form.mailboxId,
		syncIntervalMinutes: Number(form.syncIntervalMinutes),
		// A known provider signs in with the address; only "Other" sends its own user name.
		username: (custom && form.username.trim()) || form.address.trim(),
		...(form.password ? { password: form.password } : {}),
		...(form.kitePassword ? { kitePassword: form.kitePassword } : {}),
		...(custom
			? {
					imap: { host: form.imapHost.trim(), port: Number(form.imapPort), security: form.imapSecurity },
					smtp: form.smtpHost.trim()
						? { host: form.smtpHost.trim(), port: Number(form.smtpPort), security: form.smtpSecurity }
						: null,
				}
			: {}),
	};
}

export async function connectAccount(form: AccountFormState): Promise<ExternalAccountView> {
	const response = await authFetch("/api/external-accounts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(accountRequestBody(form)),
	});
	return (await readJson<{ account: ExternalAccountView }>(response, "Could not connect the account")).account;
}

export async function updateAccount(id: string, form: AccountFormState): Promise<ExternalAccountView> {
	const response = await authFetch(`/api/external-accounts/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(accountRequestBody(form)),
	});
	return (await readJson<{ account: ExternalAccountView }>(response, "Could not save the account")).account;
}

export async function testAccount(
	id: string,
): Promise<{ account: ExternalAccountView; problem: { message: string } | null }> {
	const response = await authFetch(`/api/external-accounts/${encodeURIComponent(id)}/test`, { method: "POST" });
	return readJson(response, "Could not test the connection");
}

/** **Check now**: Kite checks the account for new mail at once. */
export async function checkAccountNow(id: string): Promise<ExternalAccountView> {
	const response = await authFetch(`/api/external-accounts/${encodeURIComponent(id)}/sync`, { method: "POST" });
	return (await readJson<{ account: ExternalAccountView }>(response, "Could not check the account")).account;
}

/** Pauses or resumes checking for new mail. */
export async function setAccountChecking(id: string, enabled: boolean): Promise<ExternalAccountView> {
	const response = await authFetch(`/api/external-accounts/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ syncEnabled: enabled }),
	});
	return (await readJson<{ account: ExternalAccountView }>(response, "Could not save the account")).account;
}

export async function removeAccount(id: string): Promise<void> {
	const response = await authFetch(`/api/external-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
	await readJson(response, "Could not remove the account");
}

export const STATUS_LABELS: Record<ExternalAccountStatus, string> = {
	active: "Connected",
	paused: "Paused",
	auth_failed: "Sign-in failed",
	tls_failed: "Certificate problem",
	error: "Error",
	disabled: "Password erased",
};

/** What the owner should do about an account that is not connected, in plain words. */
export function statusHint(account: Pick<ExternalAccountView, "status" | "statusReason">): string | null {
	if (account.status === "active") return null;
	if (account.statusReason === "permission_revoked") return "Paused because your admin removed your permission.";
	if (account.statusReason === "restored") return "Restored from a backup without its password. Reconnect it.";
	if (account.status === "disabled")
		return "The saved password was erased after connected accounts were not allowed for 30 days. Reconnect it.";
	if (account.status === "auth_failed") return "Sign-in failed. Reconnect with the current (app) password.";
	if (account.status === "tls_failed") return "The server's certificate is not valid. Edit the server to retry.";
	return null;
}

/** Whether the form is complete enough to send; a new account always needs both passwords. */
export function canSubmitAccountForm(form: AccountFormState, editing: boolean, preset: PresetOption | undefined) {
	if (!form.address.includes("@") || !form.mailboxId || !preset?.passwordSignIn) return false;
	if (!editing && (!form.password || !form.kitePassword)) return false;
	if (form.preset === "other" && (!form.imapHost.trim() || !Number(form.imapPort))) return false;
	return true;
}

/** The intervals the owner can choose (spec §6.3, decision 9). */
export const SYNC_INTERVAL_OPTIONS = [
	{ value: "5", label: "Every 5 minutes" },
	{ value: "15", label: "Every 15 minutes" },
	{ value: "60", label: "Every hour" },
];

/** "just now", "3 minutes ago", "2 hours ago", or the date for anything older than a day. */
export function relativeTime(iso: string, now: Date): string {
	const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	return `on ${new Date(iso).toLocaleDateString()}`;
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Where checking an account for new mail stands, in plain words (spec §6.5), or null when the status hint already
 * says it (sign-in and certificate problems, a pause by the admin).
 */
export function syncStatusText(account: ExternalAccountView, now: Date, time = clockTime): string | null {
	const { sync } = account;
	if (account.status !== "active" && account.status !== "error") return null;
	if (!sync.enabled) return "Checking for new mail is paused.";
	const since = sync.lastSuccessAt ? ` since ${time(sync.lastSuccessAt)}` : "";
	if (account.status === "error" && sync.problem === "transient")
		return `Could not reach ${account.imap.host}${since}; Kite tries again every 6 hours.`;
	if (account.status === "error") return account.lastError ?? "Checking stopped. Edit the account to fix it.";
	if (sync.running) return "Checking for new mail…";
	if (sync.problem === "throttled" && sync.nextSyncAt)
		return `The provider is limiting connections; Kite will try again at ${time(sync.nextSyncAt)}.`;
	if (sync.problem === "transient" && sync.failures >= 3)
		return `Could not reach ${account.imap.host}${since}; retrying.`;
	if (!sync.lastSuccessAt) return "Kite checks for new mail within five minutes.";
	const next = sync.nextSyncAt && new Date(sync.nextSyncAt) > now ? ` · next check at ${time(sync.nextSyncAt)}` : "";
	return `Checked ${relativeTime(sync.lastSuccessAt, now)}${next}`;
}

/** Whether **Check now** applies: the account is checked at all (connected and not paused). */
export function canCheckNow(account: ExternalAccountView): boolean {
	return account.hasPassword && account.sync.enabled && (account.status === "active" || account.status === "error");
}
