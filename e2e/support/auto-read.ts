import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { DOMAIN } from "./constants";
import { readAdminAgent } from "./agent";
import { apiContext, apiSignIn } from "./helpers";

export const AUTO_READ_ACCOUNT_PASSWORD = "auto-read-password-123";

export type MailboxSettingsBody = {
	settings: Record<string, unknown> & {
		autonomy: string;
		capabilities: Record<string, unknown> & { mutedSenders: string[] };
		triageModelId: string | null;
		autoReadDailyLimit: number;
		dailySpendCapMicros: number | null;
		pausedUntil: string | null;
	};
	canManage: boolean;
	autoReadAvailable: boolean;
	externalProviderBlocked: boolean;
	providerLabel: string;
};

export async function okJson<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function exampleDomainId(admin: APIRequestContext): Promise<string> {
	const { domains } = await okJson<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const domain = domains.find((item) => item.hostname === DOMAIN);
	expect(domain).toBeDefined();
	return domain!.id;
}

/** Creates an account (with its personal mailbox) and returns a signed-in client for it. */
export async function createSignedInAccount(
	admin: APIRequestContext,
	username: string,
	role: "user" | "admin" = "user",
) {
	const domainId = await exampleDomainId(admin);
	const { account } = await okJson<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: { username, domainId, password: AUTO_READ_ACCOUNT_PASSWORD, role, useAllDomains: true },
		}),
	);
	const api = await apiSignIn(`${username}@${DOMAIN}`, AUTO_READ_ACCOUNT_PASSWORD);
	const { mailboxes } = await okJson<{ mailboxes: { id: string; localPart: string }[] }>(
		await api.get("/api/mailboxes"),
	);
	const mailbox = mailboxes.find((item) => item.localPart === username);
	expect(mailbox).toBeDefined();
	const session = await api.storageState();
	await trackMailboxSettings(api, mailbox!.id, () => apiContext(session));
	return { id: account.id, api, mailboxId: mailbox!.id };
}

export async function createSharedMailbox(admin: APIRequestContext, localPart: string): Promise<string> {
	const domainId = await exampleDomainId(admin);
	const response = await admin.post("/api/mailboxes", {
		data: { domainId, localPart, displayName: localPart, type: "shared" },
	});
	const { id } = await okJson<{ id: string }>(response);
	await trackMailboxSettings(admin, id, async () => admin);
	return id;
}

export async function shareMailbox(admin: APIRequestContext, mailboxId: string, userId: string, permission: string) {
	await okJson(await admin.post(`/api/mailboxes/${mailboxId}/access`, { data: { userId, permission } }));
}

export async function readMailboxSettings(api: APIRequestContext, mailboxId: string): Promise<MailboxSettingsBody> {
	return okJson<MailboxSettingsBody>(await api.get(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`));
}

/** Only the automatic reading fields, which are what these tests compare before and after a request. */
export function autoReadFields(body: MailboxSettingsBody) {
	const { autonomy, capabilities, triageModelId, autoReadDailyLimit, dailySpendCapMicros, pausedUntil } = body.settings;
	return { autonomy, capabilities, triageModelId, autoReadDailyLimit, dailySpendCapMicros, pausedUntil };
}

/** Makes the mailbox picker start on this mailbox for every page load in the context. */
export async function selectMailbox(page: Page, mailboxId: string) {
	await page.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), mailboxId);
}

/** Opens the assistant settings from the inbox and returns the "Automatic reading" section. */
export async function openAutoReadSection(page: Page) {
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	await expect(toggle).toBeVisible();
	// The full-page loader can cover the header for a while when the dev server is busy compiling.
	if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click({ timeout: 45_000 });
	const panel = page.locator("#email-assistant-panel");
	await panel.getByRole("button", { name: "Assistant settings" }).click();
	const section = panel.getByRole("region", { name: "Automatic reading" });
	await expect(section).toBeVisible();
	return section;
}

export function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

const RESTORED_MAILBOX_KEYS = [
	"autonomy",
	"capabilities",
	"triageModelId",
	"autoReadDailyLimit",
	"dailySpendCapMicros",
	"pausedUntil",
	"autoDraftEnabled",
	"dailyLimit",
	"instructions",
	"reviewerUserId",
] as const;

type AutoReadSnapshot = {
	admin: APIRequestContext;
	adminSettings: Awaited<ReturnType<typeof readAdminAgent>>;
	mailboxes: Map<string, { settings: Record<string, unknown>; manager: () => Promise<APIRequestContext> }>;
};

let snapshot: AutoReadSnapshot | null = null;

/** `manager` returns a client allowed to change the mailbox's settings (a personal mailbox is invisible to the admin). */
async function trackMailboxSettings(
	reader: APIRequestContext,
	mailboxId: string,
	manager: () => Promise<APIRequestContext>,
) {
	if (!snapshot || snapshot.mailboxes.has(mailboxId)) return;
	const { settings } = await readMailboxSettings(reader, mailboxId);
	snapshot.mailboxes.set(mailboxId, {
		settings: Object.fromEntries(
			RESTORED_MAILBOX_KEYS.filter((key) => key in settings).map((key) => [key, settings[key]]),
		),
		manager,
	});
}

/** Records the admin automatic reading settings; mailboxes created through this module are recorded as they appear. */
export async function beginAutoReadSnapshot(admin: APIRequestContext) {
	snapshot = { admin, adminSettings: await readAdminAgent(admin), mailboxes: new Map() };
}

/**
 * Puts every recorded mailbox and the admin automatic reading settings back to what they were when the snapshot
 * began. A mailbox the test deleted, or whose session or access it revoked, is skipped; any other failure fails the test.
 */
export async function restoreAutoReadSnapshot() {
	const current = snapshot;
	snapshot = null;
	if (!current) return;
	const { admin, adminSettings, mailboxes } = current;
	for (const [mailboxId, { settings, manager }] of mailboxes) {
		const client = await manager().catch(() => null);
		if (!client) continue;
		const response = await client.put("/api/agent/settings", { data: { mailboxId, ...settings } });
		const [status, body] = [response.status(), await response.text()];
		if (client !== admin) await client.dispose();
		if (![401, 403, 404].includes(status)) expect(status, `restore ${mailboxId} -> ${body}`).toBe(200);
	}
	const { autoReadEnabled, externalAutoReadAllowed, dailySpendCapMicros, assistantEnabled } = adminSettings;
	await okJson(
		await admin.put("/api/admin/agent", { data: { autoReadEnabled, externalAutoReadAllowed, dailySpendCapMicros } }),
	);
	await okJson(await admin.put("/api/admin/agent", { data: { enabled: assistantEnabled } }));
	expect(await readAdminAgent(admin)).toMatchObject({
		autoReadEnabled,
		externalAutoReadAllowed,
		dailySpendCapMicros,
		assistantEnabled,
	});
}
